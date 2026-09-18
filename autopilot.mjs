#!/usr/bin/env node
// autopilot.mjs — CLI orchestrator for the job-search autopilot's
// deterministic core: scan -> parse pipeline -> keyword gate -> dedup ->
// queue (data/autopilot-queue.md) -> Telegram digest. No LLM anywhere in
// this loop; the queue file is the hand-off surface for the agent that
// actually fills applications (and reports outcomes back via `report`).
//
// Commands:
//   node autopilot.mjs [--no-scan] [--no-tg] [--dry-run]   run one cycle
//   node autopilot.mjs status                               counts + today
//   node autopilot.mjs report "<url|url_key>" <outcome> [--note "..."] [--channel browser|ats_api|email]
//
// Untrusted input handling: everything arriving from the network via scan.mjs
// (titles, companies, locations, notes) is DATA. It is matched, counted, and
// written into the queue/db verbatim-sanitized, never executed, and the only
// outbound network peer of this script's own code is api.telegram.org
// (notify-tg.mjs pins that host; job data reaches Telegram only inside the
// message body).
//
// Windows-safe: every child process is spawned with an argv array and
// shell:false; all paths are absolute; no bash-isms.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { compileKeyword, compilePositiveKeyword } from './title-keywords.mjs';
import { normalizeUrl } from './url-key.mjs';
import { normalizeTextKey } from './tracker-parse.mjs';
import {
  openDb, addEvent, upsertJob, getJob, listJobs, reportOutcome,
  incrementDaily, normalizeUrlKey, statusCounts, JOB_STATUSES, DB_PATH,
} from './autopilot-db.mjs';
import { sendTelegram } from './notify-tg.mjs';
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

const OUTCOMES = ['applied', 'test_filled', 'failed', 'captcha', 'skipped'];
const CHANNELS = ['browser', 'ats_api', 'email'];
// Funnel policy is configuration-only. The engine itself has no built-in
// source/country/application-count exclusions; explicit user blacklist entries
// remain respected.
const REMOTE_ONLY_NEGATIVE_RE = /(\b(?:hybrid|onsite|on-?site|office[ -]based)\b|гибрид|в офисе|только офис|офисный формат)/i;
// Set for the top-level catch so even a crash mid-dry-run cannot write an
// error event into a DB the dry-run promised not to touch.
let dryRunActive = false;

// ── small utils ─────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Local-time 'YYYY-MM-DD' — the daily cap is a local-day concept. */
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

// ── pipeline.md parsing ─────────────────────────────────────────────
// Entry shape written by scan.mjs (formatPipelineOffer):
//   - [ ] <url> | <company> | <title> [| <location> [| <comp>]] [| posted: <date>] [| trust…: …] [| note: <text>]
// Fields after the title are optional and may be absent; labeled segments
// (`key: value`) can ride on any row shape, so positional cells (location,
// comp) are identified as unlabeled fields after the title.

const URL_IN_LINE_RE = /^-\s\[\s\]\s+(.*)$/;
const LABELED_FIELD_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,24}:\s*\S/;

/**
 * @param {string} text - raw data/pipeline.md content
 * @returns {Array<{url:string, company:string, title:string, location:string, comp:string, posted:string, note:string}>}
 */
export function parsePipelinePending(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const markerIdx = lines.findIndex(l => l.trim() === '## Pending' || l.trim() === '## Pendientes');
  if (markerIdx === -1) return [];
  const entries = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line.trim())) break; // next section
    const m = line.match(URL_IN_LINE_RE);
    if (!m) continue;
    let body = m[1].trim();
    // Expired entries are wrapped in ~~strikethrough~~ (scan.mjs's expiry
    // marker) — the autopilot never queues a dead posting.
    if (body.startsWith('~~')) continue;
    const fields = body.split('|').map(s => s.trim());
    const labeled = (label) => {
      const f = fields.find(f => f.toLowerCase().startsWith(`${label}:`));
      return f ? f.slice(label.length + 1).trim() : '';
    };
    const positional = fields.slice(3).filter(f => f !== '' && !LABELED_FIELD_RE.test(f));
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

// ── GATE (no LLM): title_filter from portals.yml ────────────────────
// Keyword semantics are the repo's one definition (title-keywords.mjs — the
// same module scan.mjs uses): case-insensitive substring by default,
// word-boundary anchoring for <=3-char keywords and `word:`/`stem:` prefixes,
// " + " AND-groups on the positive side.

export function loadTitleFilter() {
  const cfg = loadYamlIfExists(PORTALS_PATH);
  const tf = cfg?.title_filter;
  const normalize = (arr) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0);
  return { positive: normalize(tf?.positive), negative: normalize(tf?.negative) };
}

/**
 * @returns {{ok: true, matched: string} | {ok: false, reason: string}}
 */
export function gateTitle(title, filter) {
  const lower = String(title ?? '').toLowerCase();
  if (!lower) return { ok: false, reason: 'missing/empty title' };
  // An autonomous applier must not run with an open gate: no configured
  // positive keywords rejects everything rather than accepting everything.
  if (filter.positive.length === 0) return { ok: false, reason: 'no positive keywords configured in portals.yml' };
  const neg = filter.negative.find(k => compileKeyword(k)(lower));
  if (neg) return { ok: false, reason: `negative keyword "${neg}"` };
  const pos = filter.positive.find(k => compilePositiveKeyword(k)(lower));
  if (!pos) return { ok: false, reason: 'no positive keyword match' };
  return { ok: true, matched: pos };
}

// ── DEDUP helpers ───────────────────────────────────────────────────

/** URLs already recorded in the tracker: raw strings + normalized keys. */
function loadTrackerUrlIndex() {
  const text = readTextIfExists(TRACKER_PATH);
  if (!text) return { rawSet: new Set(), keySet: new Set(), text: '' };
  const rawSet = new Set();
  const keySet = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s|)\]'"]+/g)) {
    rawSet.add(match[0]);
    const key = normalizeUrl(match[0]);
    if (key) keySet.add(key);
  }
  return { rawSet, keySet, text };
}

/**
 * Blacklist companies from data/blacklist.md (user-layer markdown TABLE
 * `| Company | Since | Scope | Reason |`, the same shape scan.mjs parses).
 * Absent file = empty map = no filtering. Company keys use the tracker's
 * normalizeTextKey so "Acme Corp." here still catches "acme corp" there.
 */
function loadBlacklistKeys() {
  const entries = new Map();
  const text = readTextIfExists(BLACKLIST_PATH);
  if (!text) return entries;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company)) continue; // separator row
    if (company.toLowerCase() === 'company') continue;  // header row
    const key = normalizeTextKey(company);
    if (key && !entries.has(key)) entries.set(key, company);
  }
  return entries;
}

/** Explicit user-configured source exclusions; absent list means exclude nothing. */
function excludedHostTokens() {
  const list = loadYamlIfExists(PROFILE_PATH)?.autopilot?.blacklist_sources;
  return (Array.isArray(list) ? list : [])
    .filter(t => typeof t === 'string' && t.trim())
    .map(t => t.trim().toLowerCase().replace(/^\.+|\.$/g, ''));
}

export function hostMatchesToken(host, token) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  const t = String(token ?? '').toLowerCase().replace(/^\.+|\.$/g, '');
  return Boolean(h && t && (h === t || h.endsWith(`.${t}`)));
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function loadLocationPolicy() {
  const a = loadYamlIfExists(PROFILE_PATH)?.autopilot ?? {};
  return {
    remoteOnly: a.remote_only === true,
    blocked: (Array.isArray(a.blocked_locations) ? a.blocked_locations : [])
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim().toLowerCase()),
  };
}

export function gateLocation(location, policy = {}) {
  const text = String(location ?? '').trim();
  if (!text) return { ok: true };
  if (policy.remoteOnly) {
    const hit = text.match(REMOTE_ONLY_NEGATIVE_RE);
    if (hit) return { ok: false, reason: `remote_only:${hit[0]}` };
  }
  const lower = text.toLowerCase();
  const blocked = (policy.blocked ?? []).find(token => token && lower.includes(token));
  return blocked ? { ok: false, reason: `blocked_location:${blocked}` } : { ok: true };
}
// ── queue file regeneration ─────────────────────────────────────────

export function regenerateQueue() {
  const queued = listJobs('queued'); // oldest first
  const counts = statusCounts();
  const lines = [];
  lines.push('# Autopilot Queue');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Queued: ${queued.length} job(s) awaiting an outcome report (oldest first).`);
  lines.push(`Job status counts: ${JOB_STATUSES.map(s => `${s}=${counts[s] ?? 0}`).join(' ')}`);
  lines.push('');
  for (const job of queued) {
    lines.push(`## ${job.company || '?'} — ${job.title || '?'}`);
    lines.push(`URL: ${job.url || job.url_key}`);
    lines.push(`Location: ${job.location || '—'}`);
    lines.push(`Source: ${job.source || '—'}`);
    lines.push(`Queued: ${job.first_seen || ''}`);
    lines.push('');
    lines.push(`Report outcome: node autopilot.mjs report "${job.url || job.url_key}" <applied|failed|captcha|skipped|test_filled> --note "..."`);
    lines.push('');
  }
  mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  writeFileSync(QUEUE_PATH, lines.join('\n') + '\n', 'utf8');
  return queued.length;
}

// ── run command ─────────────────────────────────────────────────────

function runScanStep() {
  const res = spawnSync(process.execPath, [SCAN_PATH], {
    cwd: CODE_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (res.error) {
    addEvent('scan', `failed to spawn scan.mjs: ${res.error.message}`, null, 'error');
    console.error(`autopilot: scan spawn failed (${res.error.message}); continuing with existing pipeline`);
    return 'spawn-failed';
  }
  if (res.status !== 0) {
    addEvent('scan', `scan.mjs exited with status ${res.status}; continuing with existing pipeline`, null, 'warn');
    console.error(`autopilot: scan.mjs exited ${res.status}; continuing with existing pipeline`);
    return 'failed';
  }
  addEvent('scan', 'scan.mjs completed');
  return 'ok';
}

export async function cmdRun(flags) {
  dryRunActive = Boolean(flags.dryRun);
  const decisions = [];
  const survivors = []; // {company, title, url} of this run's newly qualified jobs
  const counts = { pending: 0, qualifiedNew: 0, alreadyKnown: 0, dupTracker: 0, gateSkipped: 0, dedupSkipped: 0 };
  let scanResult = 'skipped';

  if (!flags.dryRun) addEvent('run', 'start', { noScan: !!flags.noScan, noTg: !!flags.noTg });

  try {
    // 1. scan (unless suppressed)
    if (!flags.noScan) scanResult = runScanStep();

    // 2. parse Pending section
    const entries = parsePipelinePending(readTextIfExists(PIPELINE_PATH));
    counts.pending = entries.length;

    // 3. gate inputs; 4. dedup inputs
    const filter = loadTitleFilter();
    const tracker = loadTrackerUrlIndex();
    const blacklist = loadBlacklistKeys();
    const excludedHosts = excludedHostTokens();
    // Dry-run opens the DB only when it already exists, and never writes; a
    // missing DB file must not be created by a no-write mode.
    let db = null;
    if (!flags.dryRun) db = openDb();
    else if (existsSync(DB_PATH)) db = openDb();
    // Exact posting identity only. Company+title is NOT a safe duplicate key:
    // large employers routinely open several independent requisitions with the
    // same title. Keeping both makes the funnel wider and matches tracker logic.
    const locationPolicy = loadLocationPolicy();

    for (const entry of entries) {
      const urlKey = normalizeUrlKey(entry.url);
      const label = `${entry.company || '?'} | ${entry.title || '?'} | ${entry.url}`;

      if (!urlKey) {
        decisions.push(`SKIPPED: unparseable URL | ${label}`);
        counts.gateSkipped += 1;
        continue;
      }

      const gate = gateTitle(entry.title, filter);
      if (!gate.ok) {
        decisions.push(`SKIPPED: ${gate.reason} | ${label}`);
        counts.gateSkipped += 1;
        continue;
      }

      const host = hostOf(entry.url);
      const seenInDb = db ? Boolean(getJob(urlKey)) : false;
      // Exact-match sets only: a substring test made /job/123 match /job/1234.
      const inTracker = tracker.rawSet.has(entry.url) || tracker.keySet.has(urlKey);
      const blHit = blacklist.get(normalizeTextKey(entry.company || '')) || null;
      const hostHit = excludedHosts.find(t => hostMatchesToken(host, t));

      if (seenInDb) {
        decisions.push(`DUP: already in autopilot DB | ${label}`);
        counts.alreadyKnown += 1;
        continue;
      }
      const locationGate = gateLocation(entry.location, locationPolicy);
      if (!locationGate.ok) {
        decisions.push(`SKIPPED: ${locationGate.reason} | ${label}`);
        counts.gateSkipped += 1;
        continue;
      }
      if (inTracker) {
        decisions.push(`DUP: url already in applications.md | ${label}`);
        counts.dupTracker += 1;
        continue;
      }
      if (blHit) {
        decisions.push(`SKIPPED: blacklisted company (${blHit}) | ${label}`);
        counts.dedupSkipped += 1;
        continue;
      }
      if (hostHit) {
        decisions.push(`SKIPPED: excluded source host (${hostHit}) | ${label}`);
        counts.dedupSkipped += 1;
        continue;
      }

      // 5. survivor
      decisions.push(`QUALIFIED | ${label}`);
      survivors.push({ company: entry.company, title: entry.title, url: entry.url });
      counts.qualifiedNew += 1;
      if (!flags.dryRun) {
        upsertJob({
          urlKey,
          url: entry.url,
          source: host,
          company: entry.company,
          title: entry.title,
          location: entry.location,
          note: entry.note || null,
          status: 'queued',
        });
        addEvent('gate', 'qualified', { company: entry.company, title: entry.title, url: entry.url, matched: gate.matched });
      }
    }

    if (flags.dryRun) {
      // Print the decision for EVERY pending line, write nothing.
      dryRunActive = true;
      console.log(`dry run: ${counts.pending} pending line(s), no writes performed`);
      for (const d of decisions) console.log(d);
      console.log(`summary: qualified=${counts.qualifiedNew} dup=${counts.alreadyKnown + counts.dupTracker} skipped=${counts.gateSkipped + counts.dedupSkipped}`);
      return counts;
    }

    // 6. regenerate the agent work queue
    db = db ?? openDb();
    const queueTotal = regenerateQueue();

    // 7. Telegram digest
    let tg = 'skipped';
    if (!flags.noTg) {
      const top = survivors.slice(0, 5)
        .map(j => `${esc(j.company || '?')} — ${esc(j.title || '?')}`).join('; ');
      const text = `Autopilot: +${counts.qualifiedNew} new qualified (total queue ${queueTotal}).`
        + (top ? ` Top: ${top}` : '');
      const res = await sendTelegram(text);
      tg = res.sent ? 'sent' : `not-sent (${res.reason ?? 'unknown'})`;
    }

    // 8. human summary
    addEvent('run', 'finish', { ...counts, scan: scanResult, tg, queueTotal });
    console.log('');
    console.log('Autopilot run summary');
    console.log(`  scan: ${scanResult}`);
    console.log(`  pending lines: ${counts.pending}`);
    console.log(`  qualified (new): ${counts.qualifiedNew}`);
    console.log(`  already known (db): ${counts.alreadyKnown}`);
    console.log(`  dup (tracker): ${counts.dupTracker}`);
    console.log(`  skipped: ${counts.gateSkipped + counts.dedupSkipped} (gate ${counts.gateSkipped}, dedup ${counts.dedupSkipped})`);
    console.log(`  queue: ${queueTotal} job(s) -> ${QUEUE_PATH}`);
    console.log(`  telegram: ${tg}`);
    return counts;
  } finally {
    dryRunActive = false;
  }
}

// ── status command ──────────────────────────────────────────────────

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
    console.log(`  jobs: ${totalJobs} (${JOB_STATUSES.map(s => `${s}=${counts[s] ?? 0}`).join(' ')})`);
    console.log(`  applications: ${totalApplications}`);
    console.log(`  events: ${totalEvents}`);
    const today = localDateStr();
    const day = db.prepare('SELECT * FROM daily_state WHERE date = ?').get(today);
    console.log(`  today (${today}): applications_sent=${day?.applications_sent ?? 0}`);
  }
  if (existsSync(QUEUE_PATH)) {
    const st = statSync(QUEUE_PATH);
    console.log(`queue file: ${QUEUE_PATH} (${st.size} bytes)`);
  } else {
    console.log(`queue file: ${QUEUE_PATH} (missing)`);
  }
}

// ── report command ──────────────────────────────────────────────────

// B1 guard: required personal fields must be real, not placeholders. The agent
// must never type a fabricated contact into an employer form — if these are
// unfilled, fill/submit attempts are refused until the user fills the profile.
const PLACEHOLDER_RE = /TODO|example\.(com|org)|@example/i;
function contactPreflight() {
  const profile = loadYamlIfExists(PROFILE_PATH) ?? {};
  const c = profile.candidate ?? {};
  const problems = [];
  if (!c.email || PLACEHOLDER_RE.test(c.email)) problems.push('candidate.email (real application email)');
  if (!c.phone || PLACEHOLDER_RE.test(c.phone)) problems.push('candidate.phone');
  const cvPdf = profile.autopilot?.cv_pdf;
  if (!cvPdf || !existsSync(path.join(DATA_ROOT, cvPdf))) {
    problems.push(`autopilot.cv_pdf (set it in config/profile.yml; expected file at ${cvPdf ?? '(unset)'})`);
  }
  return problems;
}

export function cmdPreflight() {
  const problems = contactPreflight();
  // Phone is deliberately optional: many forms are email-only, and an empty
  // phone just means phone-REQUIRING forms get skipped (never fabricated).
  const blockers = problems.filter((p) => !p.startsWith('candidate.phone'));
  if (blockers.length === 0) {
    if (problems.length) console.log(`preflight OK (warnings):\n  - ${problems.join('\n  - ')}`);
    else console.log('preflight OK: contacts + CV present — fill/submit allowed');
    return true;
  }
  console.error('preflight FAILED — fill/submit is BLOCKED until these are fixed:');
  for (const p of blockers) console.error(`  - ${p}`);
  console.error('Fill them in config/profile.yml (user layer).');
  return false;
}

export function cmdCap() {
  // Backward-compatible telemetry command. Career-Ops does not impose an
  // application-count ceiling; third-party platform limits still apply.
  const db = openDb();
  const today = localDateStr();
  const sent = db.prepare('SELECT applications_sent FROM daily_state WHERE date = ?').get(today)?.applications_sent ?? 0;
  console.log(JSON.stringify({ date: today, sent, cap: null, allowed: true, remaining: null, policy: 'unlimited' }, null, 2));
  process.exitCode = 0;
}

// Canonical tracker write (#3517, #1799): TSV with a header row, score sentinel
// N/A (no evaluation), root-relative report cell, then merge-tracker.mjs.
function writeTrackerAdditionTsv(job, note) {
  const reserved = spawnSync(process.execPath, [path.join(CODE_ROOT, 'reserve-report-num.mjs'), '--count', '1'], { encoding: 'utf8' });
  if (reserved.status !== 0) throw new Error(`reserve-report-num failed: ${reserved.stderr?.trim() || reserved.status}`);
  const num = (reserved.stdout.match(/\d{1,3}/) || [])[0];
  if (!num) throw new Error(`could not parse report number from: ${reserved.stdout}`);
  const date = localDateStr();
  const slug = String(job.company || 'company').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
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
    ['notes', `autopilot ${note || 'browser apply'}`],
    ['url', job.url],
  ];
  const tsv = `${cells.map(([k]) => k).join('\t')}\n${cells.map(([, v]) => v.replace(/\t|\n/g, ' ')).join('\t')}\n`;
  writeFileSync(file, tsv, 'utf8');
  addEvent('tracker', `TSV written: ${path.basename(file)} -> merge-tracker next`, { num, company: job.company });
  const merged = spawnSync(process.execPath, [path.join(CODE_ROOT, 'merge-tracker.mjs')], { encoding: 'utf8' });
  if (merged.status !== 0) throw new Error(`merge-tracker failed: ${merged.stderr?.trim() || merged.status}`);
  return { num, file };
}

export async function cmdReport(target, outcome, note, channel) {
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`invalid outcome "${outcome}" — must be one of: ${OUTCOMES.join(' | ')}`);
  }
  if (channel != null && !CHANNELS.includes(channel)) {
    throw new Error(`invalid channel "${channel}" — must be one of: ${CHANNELS.join(' | ')} or omitted`);
  }
  if (!target) throw new Error('report needs a job URL or url_key as the first argument');

  const db = openDb();
  // normalizeUrl is idempotent, so this accepts a raw URL, an already
  // normalized url_key, or anything that normalizes onto the stored key.
  const byKey = normalizeUrlKey(target);
  const job = (byKey && getJob(byKey)) || db.prepare('SELECT * FROM jobs WHERE url = ?').get(target);
  if (!job) {
    throw new Error(`no autopilot job matches "${target}" (neither as url_key nor as exact url)`);
  }

  // B1 guard: recording a fill/submit that used placeholder contacts would
  // launder fabricated data into the tracker. Block until the profile is real.
  // Phone is a warning, not a blocker (email-only forms are fine; phone-REQUIRING
  // forms are skipped per playbook — never fabricated).
  if (outcome === 'applied' || outcome === 'test_filled') {
    const problems = contactPreflight().filter((p) => !p.startsWith('candidate.phone'));
    if (problems.length > 0) {
      addEvent('report', `refused "${outcome}": contact preflight failed`, { problems, url: job.url }, 'warn');
      throw new Error(`contact preflight failed — fix config/profile.yml first:\n  - ${problems.join('\n  - ')}`);
    }
  }

  let dailyRow = null;
  const updated = reportOutcome(job.url_key, outcome, note ?? null, channel ?? null);
  if (!updated) throw new Error(`job row vanished before update (url_key=${job.url_key})`);
  addEvent('report', `${outcome} — ${job.company || '?'} — ${job.title || '?'}`, {
    url: job.url, note: note ?? null, channel: channel ?? null,
  });
  if (outcome === 'applied') {
    dailyRow = incrementDaily(localDateStr(), 1);
    try {
      const tsv = writeTrackerAdditionTsv(job, note);
      console.log(`  tracker: row ${tsv.num} written + merged (${path.basename(tsv.file)})`);
    } catch (e) {
      addEvent('tracker', `TSV/merge failed after applied: ${e.message}`, { url: job.url }, 'error');
      console.error(`  tracker write FAILED (${e.message}) — row NOT in applications.md; record manually`);
    }
  }

  regenerateQueue();
  console.log(`reported ${outcome} for: ${job.company || '?'} — ${job.title || '?'}`);
  console.log(`  url: ${job.url}`);
  if (note) console.log(`  note: ${note}`);
  if (channel) console.log(`  channel: ${channel}`);
  if (dailyRow) console.log(`  today: ${dailyRow.applications_sent} applications sent (no engine-side cap)`);
  console.log(`  queue regenerated without it -> ${QUEUE_PATH}`);
}

// ── CLI dispatch ────────────────────────────────────────────────────

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function usage() {
  console.log(`Usage:
  node autopilot.mjs [--no-scan] [--no-tg] [--dry-run]
  node autopilot.mjs status
  node autopilot.mjs preflight        (contacts+CV guard — must pass before fill/submit)
  node autopilot.mjs cap              (compat telemetry; engine-side cap is disabled)
  node autopilot.mjs report "<url or url_key>" <applied|test_filled|failed|captcha|skipped> [--note "..."] [--channel browser|ats_api|email]`);
}

async function main() {
  const argv = process.argv.slice(2);
  const known = ['--no-scan', '--no-tg', '--dry-run'];

  if (argv[0] === 'status') {
    cmdStatus();
    return;
  }

  if (argv[0] === 'preflight') {
    const ok = cmdPreflight();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (argv[0] === 'cap') {
    cmdCap();
    return;
  }

  if (argv[0] === 'report') {
    const rest = argv.slice(1).filter(a => !a.startsWith('--note') && !a.startsWith('--channel'));
    const note = flagValue(argv, '--note');
    const channel = flagValue(argv, '--channel');
    await cmdReport(rest[0], rest[1], note, channel);
    return;
  }

  const unknown = argv.filter(a => a.startsWith('--') && !known.includes(a));
  if (unknown.length > 0 || argv.some(a => !a.startsWith('--'))) {
    console.error(`unknown argument(s): ${unknown.concat(argv.filter(a => !a.startsWith('--'))).join(' ') || '(none)'}`);
    usage();
    process.exit(1);
  }
  await cmdRun({
    noScan: argv.includes('--no-scan'),
    noTg: argv.includes('--no-tg'),
    dryRun: argv.includes('--dry-run'),
  });
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`autopilot: ${err?.message ?? err}`);
    if (!dryRunActive) {
      try {
        addEvent('run', `unhandled error: ${err?.message ?? err}`, { stack: err?.stack ?? null }, 'error');
      } catch {
        // DB unavailable — the console line above is all we can do.
      }
    }
    process.exit(1);
  });
}
