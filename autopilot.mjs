#!/usr/bin/env node
// autopilot.mjs — wide-funnel queue/state CLI for the autonomous web applier.
//
// Discovery is deterministic and zero-token:
//   scan.mjs --wide -> data/pipeline.md -> SQLite priority queue
//
// The coding agent is the application brain. It claims one job at a time,
// reads the full JD, selects/generates a resume, controls Chrome directly
// through Playwright CLI, verifies Submit evidence, and reports the outcome.
//
// Hard rejection is intentionally minimal: invalid URL, exact duplicate /
// already-known posting, and explicit user company/source blacklists. Fit,
// title and location preferences only influence priority.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { normalizeUrl } from './url-key.mjs';
import { normalizeTextKey } from './tracker-parse.mjs';
import {
  openDb, addEvent, upsertJob, getJob, listJobs, reportOutcome,
  incrementDaily, normalizeUrlKey, statusCounts, recentEvents, applicationAnalytics,
  claimNextJob, releaseClaim, renewClaim, JOB_STATUSES, DB_PATH,
} from './autopilot-db.mjs';
import { resolveResume } from './autopilot-resume.mjs';
import { scoreJob } from './autopilot-ranking.mjs';
import { auditLog, auditLogPath } from './autopilot-log.mjs';
import {
  checkPlaywrightCli,
  loadEvidenceReceipt,
  evidenceMatchesOutcome,
} from './autopilot-verify.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(DATA_ROOT, 'portals.yml');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || path.join(DATA_ROOT, 'config/profile.yml');
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE || path.join(DATA_ROOT, 'data', 'pipeline.md');
const TRACKER_PATH = resolveTrackerPath(DATA_ROOT);
const BLACKLIST_PATH = path.join(DATA_ROOT, 'data', 'blacklist.md');
export const QUEUE_PATH = path.join(DATA_ROOT, 'data', 'autopilot-queue.md');
const SCAN_PATH = path.join(CODE_ROOT, 'scan.mjs');
const ATS_FULL_PATH = path.join(CODE_ROOT, 'scan-ats-full.mjs');
const SOURCE_REGISTRY_PATH = path.join(CODE_ROOT, 'source-registry.mjs');
const REGIONAL_PORTALS_PATH = process.env.CAREER_OPS_EXPANDED_PORTALS
  || path.join(DATA_ROOT, 'data', 'portals-regional.generated.yml');

const OUTCOMES = [
  'applied', 'submitted_unconfirmed', 'validation_failed',
  'failed', 'captcha', 'skipped',
];
export const APPLICATION_CHANNELS = ['browser'];
let dryRunActive = false;

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readTextIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function loadYamlIfExists(p) {
  const text = readTextIfExists(p);
  if (!text.trim()) return {};
  const parsed = yaml.load(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

const URL_IN_LINE_RE = /^-\s\[\s\]\s+(.*)$/;
const LABELED_FIELD_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,24}:\s*\S/;

export function parsePipelinePending(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const markerIdx = lines.findIndex(
    (l) => l.trim() === '## Pending' || l.trim() === '## Pendientes',
  );
  if (markerIdx === -1) return [];

  const entries = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line.trim())) break;
    const m = line.match(URL_IN_LINE_RE);
    if (!m) continue;
    const body = m[1].trim();
    if (body.startsWith('~~')) continue;

    const fields = body.split('|').map((s) => s.trim());
    const labeled = (label) => {
      const f = fields.find((v) => v.toLowerCase().startsWith(`${label}:`));
      return f ? f.slice(label.length + 1).trim() : '';
    };
    const positional = fields
      .slice(3)
      .filter((f) => f !== '' && !LABELED_FIELD_RE.test(f));

    entries.push({
      url: fields[0] || '',
      company: fields[1] || '',
      title: fields[2] || '',
      location: positional[0] || '',
      comp: positional[1] || '',
      posted: labeled('posted'),
      note: labeled('note'),
    });
  }
  return entries;
}

function loadTitleFilter() {
  const tf = loadYamlIfExists(PORTALS_PATH)?.title_filter || {};
  const norm = (v) => (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim());
  return { positive: norm(tf.positive), negative: norm(tf.negative) };
}

function loadTrackerUrlIndex() {
  const text = readTextIfExists(TRACKER_PATH);
  if (!text) return { rawSet: new Set(), keySet: new Set() };
  const rawSet = new Set();
  const keySet = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s|)\]'"]+/g)) {
    rawSet.add(match[0]);
    const key = normalizeUrl(match[0]);
    if (key) keySet.add(key);
  }
  return { rawSet, keySet };
}

function loadBlacklistKeys() {
  const entries = new Map();
  const text = readTextIfExists(BLACKLIST_PATH);
  if (!text) return entries;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company) || company.toLowerCase() === 'company') continue;
    const key = normalizeTextKey(company);
    if (key && !entries.has(key)) entries.set(key, company);
  }
  return entries;
}

function excludedHostTokens(profile) {
  const list = profile?.autopilot?.blacklist_sources;
  return (Array.isArray(list) ? list : [])
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim().toLowerCase().replace(/^\.+|\.+$/g, ''));
}

export function hostMatchesToken(host, token) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  const t = String(token ?? '').toLowerCase().replace(/^\.+|\.+$/g, '');
  return Boolean(h && t && (h === t || h.endsWith(`.${t}`)));
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function regenerateQueue() {
  const queued = listJobs('queued');
  const counts = statusCounts();
  const lines = [
    '# Autopilot Queue',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Queued: ${queued.length} job(s), ordered by priority then freshness.`,
    `Job status counts: ${JOB_STATUSES.map((s) => `${s}=${counts[s] ?? 0}`).join(' ')}`,
    '',
  ];

  for (const job of queued) {
    let reasons = [];
    try { reasons = JSON.parse(job.rank_reasons_json || '[]'); } catch {}
    lines.push(`## [P${job.priority ?? 50}] ${job.company || '?'} — ${job.title || '?'}`);
    lines.push(`URL: ${job.url || job.url_key}`);
    lines.push(`Location: ${job.location || '—'}`);
    lines.push(`Source: ${job.source || '—'}`);
    lines.push(`Posted: ${job.posted_at || '—'}`);
    if (reasons.length) lines.push(`Rank: ${reasons.join('; ')}`);
    lines.push('');
  }

  mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  writeFileSync(QUEUE_PATH, lines.join('\n') + '\n', 'utf8');
  return queued.length;
}

function runNodeDiscoveryStep(label, script, args, extraEnv = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: CODE_ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) {
    addEvent('scan', `${label}: spawn failed: ${res.error.message}`, null, 'error');
    return `${label}:spawn-failed`;
  }
  if (res.status !== 0) {
    addEvent('scan', `${label}: exited ${res.status}; continuing`, null, 'warn');
    return `${label}:failed`;
  }
  addEvent('scan', `${label}: completed`);
  return `${label}:ok`;
}

function runScanStep({ deep = false, refreshRegistry = false } = {}) {
  const results = [
    runNodeDiscoveryStep('configured', SCAN_PATH, ['--wide']),
  ];

  if (!deep) return results.join(' ');

  // Regional registry export merges the user's portals with verified catalog
  // boards/companies. Full refresh is explicit because it can perform a much
  // larger discovery/verification crawl.
  const registryCommand = refreshRegistry ? 'full' : 'export';
  const registry = runNodeDiscoveryStep(
    `registry-${registryCommand}`,
    SOURCE_REGISTRY_PATH,
    [registryCommand],
  );
  results.push(registry);

  if (registry.endsWith(':ok')) {
    results.push(runNodeDiscoveryStep(
      'regional',
      SCAN_PATH,
      ['--wide'],
      { CAREER_OPS_PORTALS: REGIONAL_PORTALS_PATH },
    ));
  }

  // Broad reverse scan over public ATS directories plus the maintained VC seed
  // sets. This is deliberately a deep-scan lane rather than every refresh:
  // walking thousands of boards is useful, but needlessly expensive hourly.
  results.push(runNodeDiscoveryStep(
    'ats-full',
    ATS_FULL_PATH,
    [
      '--wide',
      '--since', '7',
      '--include-undated',
      '--ats', 'greenhouse,lever,ashby,workday,icims',
      '--seeds', 'yc,a16z',
    ],
  ));

  return results.join(' ');
}

export async function cmdRun(flags = {}) {
  dryRunActive = Boolean(flags.dryRun);
  const decisions = [];
  const counts = {
    pending: 0,
    queuedNew: 0,
    alreadyKnown: 0,
    dupTracker: 0,
    hardSkipped: 0,
  };
  let scanResult = 'skipped';

  if (!flags.dryRun) {
    addEvent('run', 'start', {
      noScan: !!flags.noScan,
      deepScan: !!flags.deepScan,
      refreshRegistry: !!flags.refreshRegistry,
      policy: 'wide-funnel',
    });
    auditLog('run_start', {
      no_scan: !!flags.noScan,
      deep_scan: !!flags.deepScan,
      refresh_registry: !!flags.refreshRegistry,
      policy: 'wide-funnel',
    });
  }

  try {
    if (!flags.noScan && !flags.dryRun) {
      scanResult = runScanStep({
        deep: !!flags.deepScan,
        refreshRegistry: !!flags.refreshRegistry,
      });
    } else if (flags.dryRun) {
      scanResult = 'dry-run:no-network-scan';
    }

    const entries = parsePipelinePending(readTextIfExists(PIPELINE_PATH));
    counts.pending = entries.length;

    const profile = loadYamlIfExists(PROFILE_PATH);
    const titleFilter = loadTitleFilter();
    const tracker = loadTrackerUrlIndex();
    const blacklist = loadBlacklistKeys();
    const excludedHosts = excludedHostTokens(profile);

    let db = null;
    if (!flags.dryRun) db = openDb();
    else if (existsSync(DB_PATH)) db = openDb();

    for (const entry of entries) {
      const urlKey = normalizeUrlKey(entry.url);
      const label = `${entry.company || '?'} | ${entry.title || '?'} | ${entry.url}`;

      if (!urlKey) {
        decisions.push(`SKIPPED hard: invalid URL | ${label}`);
        counts.hardSkipped++;
        continue;
      }

      const existingJob = db ? getJob(urlKey) : null;
      const inTracker = tracker.rawSet.has(entry.url) || tracker.keySet.has(urlKey);
      const blacklistedCompany = blacklist.get(normalizeTextKey(entry.company || '')) || null;
      const host = hostOf(entry.url);
      const blacklistedSource = excludedHosts.find((t) => hostMatchesToken(host, t));

      if (existingJob) {
        counts.alreadyKnown++;
        if (!flags.dryRun && existingJob.status === 'queued') {
          const rank = scoreJob(entry, { titleFilter, profile });
          upsertJob({
            urlKey,
            url: entry.url,
            source: hostOf(entry.url),
            company: entry.company,
            title: entry.title,
            location: entry.location,
            postedAt: entry.posted || null,
            note: entry.note || null,
            priority: rank.priority,
            rankReasons: rank.reasons,
            status: 'queued',
          });
          decisions.push(`REFRESHED P${rank.priority}: existing queued job | ${label}`);
        } else {
          decisions.push(`DUP: already in autopilot DB (${existingJob.status}) | ${label}`);
        }
        continue;
      }
      if (inTracker) {
        decisions.push(`DUP: URL already in applications tracker | ${label}`);
        counts.dupTracker++;
        continue;
      }
      if (blacklistedCompany) {
        decisions.push(`SKIPPED hard: explicit company blacklist (${blacklistedCompany}) | ${label}`);
        counts.hardSkipped++;
        continue;
      }
      if (blacklistedSource) {
        decisions.push(`SKIPPED hard: explicit source blacklist (${blacklistedSource}) | ${label}`);
        counts.hardSkipped++;
        continue;
      }

      const rank = scoreJob(entry, { titleFilter, profile });
      decisions.push(`QUEUED P${rank.priority} | ${label}`);
      counts.queuedNew++;

      if (!flags.dryRun) {
        upsertJob({
          urlKey,
          url: entry.url,
          source: host,
          company: entry.company,
          title: entry.title,
          location: entry.location,
          postedAt: entry.posted || null,
          note: entry.note || null,
          priority: rank.priority,
          rankReasons: rank.reasons,
          status: 'queued',
        });
        addEvent('queue', 'queued', {
          company: entry.company,
          title: entry.title,
          url: entry.url,
          priority: rank.priority,
        });
      }
    }

    if (flags.dryRun) {
      console.log(`dry run: ${counts.pending} pending line(s), no writes performed`);
      for (const d of decisions) console.log(d);
      console.log(
        `summary: queued=${counts.queuedNew} dup=${counts.alreadyKnown + counts.dupTracker} hard_skipped=${counts.hardSkipped}`,
      );
      return counts;
    }

    const queueTotal = regenerateQueue();
    addEvent('run', 'finish', { ...counts, scan: scanResult, queueTotal });
    auditLog('run_finish', { ...counts, scan: scanResult, queue_total: queueTotal });

    console.log('');
    console.log('Autopilot run summary');
    console.log(`  scan: ${scanResult}`);
    console.log(`  pending lines: ${counts.pending}`);
    console.log(`  queued (new): ${counts.queuedNew}`);
    console.log(`  already known (db): ${counts.alreadyKnown}`);
    console.log(`  dup (tracker): ${counts.dupTracker}`);
    console.log(`  hard skipped: ${counts.hardSkipped}`);
    console.log(`  queue: ${queueTotal} job(s) -> ${QUEUE_PATH}`);
    return counts;
  } finally {
    dryRunActive = false;
  }
}

export function cmdStatus() {
  console.log(`DB: ${DB_PATH}`);
  if (!existsSync(DB_PATH)) {
    console.log('  (not created yet — run `node autopilot.mjs` first)');
  } else {
    const db = openDb();
    const counts = statusCounts();
    const totalJobs = Object.values(counts).reduce((a, b) => a + b, 0);
    const totalEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const totalApplications = db.prepare('SELECT COUNT(*) AS n FROM applications').get().n;
    console.log(
      `  jobs: ${totalJobs} (${JOB_STATUSES.map((s) => `${s}=${counts[s] ?? 0}`).join(' ')})`,
    );
    console.log(`  applications: ${totalApplications}`);
    console.log(`  events: ${totalEvents}`);
    const today = localDateStr();
    const day = db.prepare('SELECT * FROM daily_state WHERE date = ?').get(today);
    console.log(`  today (${today}): confirmed_applications=${day?.applications_sent ?? 0}`);
  }

  console.log(`audit log: ${auditLogPath()}`);
  if (existsSync(QUEUE_PATH)) {
    const st = statSync(QUEUE_PATH);
    console.log(`queue file: ${QUEUE_PATH} (${st.size} bytes)`);
  } else {
    console.log(`queue file: ${QUEUE_PATH} (missing)`);
  }
}

export function cmdLogs(limit = 50) {
  if (!existsSync(DB_PATH)) {
    console.log('autopilot DB does not exist yet');
    console.log(`audit log: ${auditLogPath()}`);
    return;
  }
  const rows = recentEvents(limit);
  console.log(`audit log: ${auditLogPath()}`);
  console.log(`recent SQLite events: ${rows.length}`);
  for (const row of rows.reverse()) {
    console.log(`${row.ts} [${row.level}] ${row.category}: ${row.message}`);
  }
}

export function cmdAnalytics() {
  if (!existsSync(DB_PATH)) {
    console.log(JSON.stringify({
      total: 0,
      applied: 0,
      submitted_unconfirmed: 0,
      success_rate: 0,
      by_outcome: [],
      by_channel: [],
      by_ats: [],
      by_resume: [],
      top_errors: [],
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(applicationAnalytics(), null, 2));
}

const PLACEHOLDER_RE = /TODO|example\.(com|org)|@example/i;

function contactPreflight() {
  const profile = loadYamlIfExists(PROFILE_PATH) ?? {};
  const candidate = profile.candidate ?? {};
  const problems = [];
  if (!candidate.email || PLACEHOLDER_RE.test(candidate.email)) {
    problems.push('candidate.email (real application email)');
  }
  if (!candidate.phone || PLACEHOLDER_RE.test(candidate.phone)) {
    problems.push('candidate.phone');
  }
  const resume = resolveResume({ profile });
  if (!resume.ok) {
    problems.push(
      'autopilot resume (configure an existing prepared fallback/variant or legacy autopilot.cv_pdf)',
    );
  }
  return problems;
}

export function cmdPreflight() {
  const problems = contactPreflight();
  // Phone stays a warning because many forms do not require one.
  const blockers = problems.filter((p) => !p.startsWith('candidate.phone'));
  const browser = checkPlaywrightCli();
  if (!browser.ok) blockers.push(`playwright-cli: ${browser.reason}`);

  if (blockers.length === 0) {
    if (problems.length) {
      console.log(`preflight OK (warnings):\n  - ${problems.join('\n  - ')}`);
    } else {
      console.log('preflight OK: candidate email + resume + Playwright CLI present');
    }
    return true;
  }

  console.error('preflight FAILED — autonomous application work is blocked:');
  for (const p of blockers) console.error(`  - ${p}`);
  return false;
}

export function cmdCap() {
  // Compatibility telemetry only: Career-Ops itself has no application ceiling.
  const db = openDb();
  const today = localDateStr();
  const sent = db
    .prepare('SELECT applications_sent FROM daily_state WHERE date = ?')
    .get(today)?.applications_sent ?? 0;
  console.log(JSON.stringify({
    date: today,
    sent,
    cap: null,
    allowed: true,
    remaining: null,
    policy: 'unlimited',
  }, null, 2));
}

export function cmdNext({
  owner = process.env.AUTOPILOT_WORKER_ID || 'worker-0',
  leaseMinutes = 120,
  json = false,
} = {}) {
  const job = claimNextJob(owner, leaseMinutes);
  regenerateQueue();

  if (!job) {
    if (json) console.log(JSON.stringify({ job: null }));
    else console.log('queue empty');
    return null;
  }

  let reasons = [];
  try { reasons = JSON.parse(job.rank_reasons_json || '[]'); } catch {}
  const packet = { ...job, rank_reasons: reasons };
  delete packet.rank_reasons_json;

  if (json) {
    console.log(JSON.stringify(packet, null, 2));
  } else {
    console.log(`claimed P${job.priority ?? 50}: ${job.company || '?'} — ${job.title || '?'}`);
    console.log(`  url: ${job.url}`);
    console.log(`  owner: ${job.claim_owner}`);
    console.log(`  lease until: ${job.claim_until}`);
  }
  return packet;
}

export function cmdRelease(
  target,
  owner = process.env.AUTOPILOT_WORKER_ID || 'worker-0',
) {
  if (!target) throw new Error('release requires a job URL or url_key');
  const key = normalizeUrlKey(target) || target;
  const changed = releaseClaim(key, owner);
  regenerateQueue();
  if (!changed) throw new Error('no matching claimed job for this owner');
  console.log(`released to queue: ${key}`);
}

export function cmdRenew(
  target,
  owner = process.env.AUTOPILOT_WORKER_ID || 'worker-0',
  leaseMinutes = 120,
) {
  if (!target) throw new Error('renew requires a job URL or url_key');
  const key = normalizeUrlKey(target) || target;
  const row = renewClaim(key, owner, leaseMinutes);
  if (!row) throw new Error('no matching claimed job for this owner');
  console.log(`renewed lease until ${row.claim_until}: ${key}`);
  return row;
}

function writeTrackerAdditionTsv(job, note) {
  const reserved = spawnSync(
    process.execPath,
    [path.join(CODE_ROOT, 'reserve-report-num.mjs'), '--count', '1'],
    { encoding: 'utf8' },
  );
  if (reserved.status !== 0) {
    throw new Error(`reserve-report-num failed: ${reserved.stderr?.trim() || reserved.status}`);
  }
  const num = (reserved.stdout.match(/\d{1,3}/) || [])[0];
  if (!num) throw new Error(`could not parse report number from: ${reserved.stdout}`);

  const date = localDateStr();
  const slug = String(job.company || 'company')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'company';
  const dir = path.join(DATA_ROOT, 'batch', 'tracker-additions');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${num}-${slug}.tsv`);

  const cells = [
    ['num', String(num)],
    ['date', date],
    ['company', String(job.company || '?')],
    ['role', String(job.title || '?')],
    ['status', 'Applied'],
    ['score', 'N/A'],
    ['pdf', '✅'],
    ['report', '—'],
    ['notes', `autopilot ${note || 'verified browser apply'}`],
    ['url', job.url],
  ];
  const tsv = `${cells.map(([k]) => k).join('\t')}\n`
    + `${cells.map(([, v]) => v.replace(/\t|\n/g, ' ')).join('\t')}\n`;
  writeFileSync(file, tsv, 'utf8');

  const merged = spawnSync(
    process.execPath,
    [path.join(CODE_ROOT, 'merge-tracker.mjs')],
    { encoding: 'utf8' },
  );
  if (merged.status !== 0) {
    throw new Error(`merge-tracker failed: ${merged.stderr?.trim() || merged.status}`);
  }
  return { num, file };
}

export async function cmdReport(target, outcome, note, channel, metadata = {}) {
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(
      `invalid outcome "${outcome}" — must be one of: ${OUTCOMES.join(' | ')}`,
    );
  }
  if (channel != null && !APPLICATION_CHANNELS.includes(channel)) {
    throw new Error(
      `invalid channel "${channel}" — autonomous submissions currently support browser only`,
    );
  }
  if (!target) throw new Error('report needs a job URL or url_key');

  const db = openDb();
  const byKey = normalizeUrlKey(target);
  const job = (byKey && getJob(byKey))
    || db.prepare('SELECT * FROM jobs WHERE url = ?').get(target);
  if (!job) throw new Error(`no autopilot job matches "${target}"`);

  const owner = metadata.owner
    || process.env.AUTOPILOT_WORKER_ID
    || 'worker-0';
  if (job.status !== 'claimed') {
    throw new Error(
      `job is not actively claimed (status=${job.status || 'unknown'}); use "autopilot.mjs next" first`,
    );
  }
  if (job.claim_owner !== owner) {
    throw new Error(
      `job is claimed by "${job.claim_owner || 'unknown'}", not "${owner}"`,
    );
  }

  if (outcome === 'applied') {
    const blockers = contactPreflight().filter((p) => !p.startsWith('candidate.phone'));
    if (blockers.length) {
      throw new Error(`contact preflight failed:\n  - ${blockers.join('\n  - ')}`);
    }
  }

  // A browser click is never proof of submission. Confirmed and ambiguous
  // browser submissions must be bound to a deterministic evidence receipt.
  let evidence = null;
  if (['applied', 'submitted_unconfirmed'].includes(outcome)) {
    if (!metadata.evidencePath) {
      throw new Error(
        `browser outcome "${outcome}" requires --evidence from autopilot-verify.mjs finish`,
      );
    }
    const loaded = loadEvidenceReceipt(metadata.evidencePath);
    const match = evidenceMatchesOutcome(
      loaded.receipt,
      job.url_key,
      outcome,
      { claimedAt: job.claimed_at },
    );
    if (!match.ok) throw new Error(`evidence rejected: ${match.reason}`);
    evidence = {
      attempt_id: loaded.receipt.attempt_id,
      verification: loaded.receipt.verification,
      receipt: loaded.path,
    };
  }

  const details = {
    ...(metadata.details || {}),
    ...(evidence ? { evidence } : {}),
  };
  const updated = reportOutcome(
    job.url_key,
    outcome,
    note ?? null,
    channel ?? null,
    { ...metadata, details, claimOwner: owner },
  );
  if (!updated) throw new Error(`job row vanished before update (url_key=${job.url_key})`);

  // Do not mirror free-form notes or form values into telemetry.
  addEvent('report', `${outcome} — ${job.company || '?'} — ${job.title || '?'}`, {
    channel: channel ?? null,
    ats: metadata.ats ?? null,
    resumeVariant: metadata.resumeVariant ?? null,
    durationMs: metadata.durationMs ?? null,
    evidenceAttempt: evidence?.attempt_id ?? null,
  });
  auditLog('application_result', {
    job_url_key: job.url_key,
    company: job.company || null,
    title: job.title || null,
    outcome,
    channel: channel ?? null,
    ats: metadata.ats ?? null,
    resume_variant: metadata.resumeVariant ?? null,
    resume_path: metadata.resumePath ?? null,
    duration_ms: metadata.durationMs ?? null,
    evidence_attempt: evidence?.attempt_id ?? null,
  });

  let dailyRow = null;
  if (outcome === 'applied') {
    dailyRow = incrementDaily(localDateStr(), 1);
    try {
      const tsv = writeTrackerAdditionTsv(job, note);
      console.log(
        `  tracker: row ${tsv.num} written + merged (${path.basename(tsv.file)})`,
      );
    } catch (e) {
      addEvent('tracker', `TSV/merge failed after applied: ${e.message}`, null, 'error');
      console.error(`  tracker write FAILED (${e.message})`);
    }
  }

  regenerateQueue();
  console.log(`reported ${outcome} for: ${job.company || '?'} — ${job.title || '?'}`);
  console.log(`  url: ${job.url}`);
  if (channel) console.log(`  channel: ${channel}`);
  if (metadata.ats) console.log(`  ats: ${metadata.ats}`);
  if (metadata.resumeVariant) console.log(`  resume: ${metadata.resumeVariant}`);
  if (metadata.evidencePath) console.log(`  evidence: ${metadata.evidencePath}`);
  if (dailyRow) {
    console.log(`  today: ${dailyRow.applications_sent} confirmed applications`);
  }
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
    return argv[i + 1];
  }
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function usage() {
  console.log(`Usage:
  node autopilot.mjs [--no-scan] [--deep-scan] [--refresh-registry] [--dry-run]
  node autopilot.mjs status
  node autopilot.mjs logs [--limit 50]
  node autopilot.mjs analytics
  node autopilot.mjs preflight
  node autopilot.mjs cap
  node autopilot.mjs next [--owner worker-0] [--lease-minutes 120] [--json]
  node autopilot.mjs renew "<url|url_key>" [--owner worker-0] [--lease-minutes 120]
  node autopilot.mjs release "<url|url_key>" [--owner worker-0]
  node autopilot.mjs report "<url|url_key>" <applied|submitted_unconfirmed|validation_failed|failed|captcha|skipped>
      [--owner worker-0] [--channel browser] [--evidence path] [--ats name]
      [--resume variant] [--resume-path path] [--duration-ms N] [--note "..."]`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'status') return cmdStatus();
  if (argv[0] === 'logs') return cmdLogs(flagValue(argv, '--limit') || 50);
  if (argv[0] === 'analytics') return cmdAnalytics();
  if (argv[0] === 'preflight') {
    process.exitCode = cmdPreflight() ? 0 : 1;
    return;
  }
  if (argv[0] === 'cap') return cmdCap();

  if (argv[0] === 'next') {
    const leaseRaw = flagValue(argv, '--lease-minutes');
    const leaseMinutes = leaseRaw == null ? 120 : Number(leaseRaw);
    if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0) {
      throw new Error('--lease-minutes must be > 0');
    }
    cmdNext({
      owner: flagValue(argv, '--owner')
        || process.env.AUTOPILOT_WORKER_ID
        || 'worker-0',
      leaseMinutes,
      json: argv.includes('--json'),
    });
    return;
  }

  if (argv[0] === 'release') {
    cmdRelease(
      argv[1],
      flagValue(argv, '--owner')
        || process.env.AUTOPILOT_WORKER_ID
        || 'worker-0',
    );
    return;
  }

  if (argv[0] === 'renew') {
    const leaseRaw = flagValue(argv, '--lease-minutes');
    const leaseMinutes = leaseRaw == null ? 120 : Number(leaseRaw);
    if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0) {
      throw new Error('--lease-minutes must be > 0');
    }
    cmdRenew(
      argv[1],
      flagValue(argv, '--owner')
        || process.env.AUTOPILOT_WORKER_ID
        || 'worker-0',
      leaseMinutes,
    );
    return;
  }

  if (argv[0] === 'report') {
    const durationRaw = flagValue(argv, '--duration-ms');
    const durationMs = durationRaw == null ? null : Number(durationRaw);
    if (durationRaw != null && (!Number.isFinite(durationMs) || durationMs < 0)) {
      throw new Error('--duration-ms must be a non-negative number');
    }
    await cmdReport(
      argv[1],
      argv[2],
      flagValue(argv, '--note'),
      flagValue(argv, '--channel'),
      {
        ats: flagValue(argv, '--ats') || null,
        resumeVariant: flagValue(argv, '--resume') || null,
        resumePath: flagValue(argv, '--resume-path') || null,
        durationMs,
        evidencePath: flagValue(argv, '--evidence') || null,
        owner: flagValue(argv, '--owner')
          || process.env.AUTOPILOT_WORKER_ID
          || 'worker-0',
      },
    );
    return;
  }

  const known = new Set(['--no-scan', '--deep-scan', '--refresh-registry', '--dry-run']);
  const invalid = argv.filter((a) => !known.has(a));
  if (invalid.length) {
    usage();
    throw new Error(`unknown argument(s): ${invalid.join(' ')}`);
  }
  if (argv.includes('--refresh-registry') && !argv.includes('--deep-scan')) {
    throw new Error('--refresh-registry requires --deep-scan');
  }
  if (argv.includes('--no-scan') && argv.includes('--deep-scan')) {
    throw new Error('--no-scan cannot be combined with --deep-scan');
  }
  await cmdRun({
    noScan: argv.includes('--no-scan'),
    deepScan: argv.includes('--deep-scan'),
    refreshRegistry: argv.includes('--refresh-registry'),
    dryRun: argv.includes('--dry-run'),
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`autopilot: ${err?.message ?? err}`);
    if (!dryRunActive) {
      try {
        addEvent('run', `unhandled error: ${err?.message ?? err}`, null, 'error');
        auditLog('unhandled_error', { error: err?.message ?? String(err) }, { level: 'error' });
      } catch {}
    }
    process.exit(1);
  });
}
