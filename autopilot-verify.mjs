#!/usr/bin/env node
// autopilot-verify.mjs — deterministic submit evidence for the autonomous
// Playwright CLI worker.
//
// This is intentionally NOT another browser action DSL. The coding agent
// controls the live browser directly through `npx playwright cli`. This module
// only inspects that same named session immediately before and after Submit and
// writes a local evidence receipt.
//
// Usage:
//   node autopilot-verify.mjs doctor
//   node autopilot-verify.mjs begin "<job-url>" [--session career-ops-worker-0]
//   node autopilot-verify.mjs finish "<receipt-path>"
//   node autopilot-verify.mjs classify "<fixture.json>"

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizeUrlKey } from './autopilot-db.mjs';
import { auditLog } from './autopilot-log.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();
export const EVIDENCE_ROOT = path.join(DATA_ROOT, 'data', 'autopilot', 'evidence');
const DEFAULT_SESSION = process.env.AUTOPILOT_BROWSER_SESSION || 'career-ops-worker-0';
const DEFAULT_PROFILE = process.env.AUTOPILOT_BROWSER_PROFILE
  || path.join(DATA_ROOT, 'data', 'browser-profile');

const SUCCESS_TEXT_RE = [
  /thank you (?:for|.*)applying/i,
  /thanks for applying/i,
  /application (?:has been )?(?:received|submitted)/i,
  /successfully submitted/i,
  /we(?:'|’)ve received your application/i,
  /application complete/i,
  /спасибо.{0,60}(?:отклик|заявк)/i,
  /(?:отклик|заявк).{0,40}(?:отправлен|принят|получен)/i,
  /bewerbung.{0,50}(?:eingegangen|übermittelt|gesendet)/i,
  /vielen dank.{0,60}bewerbung/i,
  /candidature.{0,50}(?:reçue|envoyée|transmise)/i,
  /merci.{0,60}candidature/i,
  /(?:solicitud|postulación).{0,50}(?:enviada|recibida)/i,
  /gracias.{0,60}(?:solicitud|postulación)/i,
  /candidatura.{0,50}(?:enviada|recebida)/i,
];
const SUCCESS_URL_RE = /\/(?:thank(?:-?you)?|success|confirmation|submitted|application[-_/]?complete|application[-_/]?success)(?:[/?#]|$)/i;
const BLOCKED_RE = /captcha|verify you are human|are you a human|cloudflare|access denied|bot detection|robot check/i;
const FAILURE_TEXT_RE = /submission failed|application failed|unable to submit|could not submit|something went wrong/i;
const SUBMISSION_URL_RE = /apply|application|candidate|submission|submit|job[-_/]?application|graphql/i;
const SUBMISSION_BODY_RE = /application|candidate|resume|cv|job(?:Id|Posting|Requisition)|firstName|lastName|email|answers?/i;
const RESPONSE_SUCCESS_RE = /success|submitted|received|application(?:Id|_id)?/i;
const RESPONSE_ERROR_RE = /error|invalid|required|failed|failure/i;

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : null;
}

function safeSession(raw) {
  const value = String(raw || DEFAULT_SESSION).trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) throw new Error('invalid Playwright CLI session name');
  return value;
}

function npxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

export function checkPlaywrightCli() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    return { ok: false, reason: `Playwright CLI requires Node 20+ (current ${process.version})` };
  }
  const res = spawnSync(npxCommand(), ['--no-install', 'playwright', 'cli', '--help'], {
    encoding: 'utf8',
    shell: false,
    timeout: 20_000,
  });
  if (res.error) return { ok: false, reason: res.error.message };
  if (res.status !== 0) {
    return { ok: false, reason: String(res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 500) };
  }
  return { ok: true, version: 'project-local Playwright CLI available' };
}

function runCli(session, args, { raw = false, timeout = 30_000, allowFailure = false } = {}) {
  const argv = ['--no-install', 'playwright', 'cli', `-s=${safeSession(session)}`];
  if (raw) argv.push('--raw');
  argv.push(...args);
  const res = spawnSync(npxCommand(), argv, {
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`playwright-cli ${args[0]} failed: ${String(res.stderr || res.stdout || res.status).trim().slice(0, 1200)}`);
  }
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

function parseJsonish(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty JSON result from Playwright CLI');
  const candidates = [raw];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'string') {
        try { return JSON.parse(parsed); } catch { return parsed; }
      }
      return parsed;
    } catch { /* try next */ }
  }
  throw new Error(`could not parse Playwright CLI JSON result: ${raw.slice(0, 300)}`);
}

function pageProbeCode(settleMs = 0) {
  const wait = Math.max(0, Math.min(10_000, Number(settleMs) || 0));
  return `async page => {
    if (${wait} > 0) await page.waitForTimeout(${wait});
    const frames = [];
    for (const frame of page.frames()) {
      try {
        const state = await frame.evaluate(() => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
          };
          const textOf = (el) => String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          const controls = [...document.querySelectorAll('input, textarea, select')].filter(visible);
          const radioGroupChecked = (el) => {
            const name = el.getAttribute('name');
            if (!name) return el.checked;
            return controls.some((other) =>
              other.type === 'radio' && other.getAttribute('name') === name && other.checked
            );
          };
          const requiredMissing = controls.filter((el) => {
            const required = el.required || el.getAttribute('aria-required') === 'true';
            if (!required) return false;
            if (el.type === 'radio') return !radioGroupChecked(el);
            if (el.type === 'checkbox') return !el.checked;
            return !String(el.value || '').trim();
          }).map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.getAttribute('name') || el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
          }));
          const dedupRequired = [...new Map(requiredMissing.map((item) => [
            item.type === 'radio' ? `radio:${item.name}` : `${item.tag}:${item.type}:${item.name}`,
            item
          ])).values()].slice(0, 30);
          const errorSelectors = [
            '[role="alert"]',
            '[aria-live="assertive"]',
            '[aria-invalid="true"]',
            '.field-error',
            '.form-error',
            '[class*="error-message"]',
            '[data-error]'
          ];
          const validationErrors = [...new Set(errorSelectors.flatMap((sel) =>
            [...document.querySelectorAll(sel)].filter(visible).map(textOf).filter(Boolean)
          ))].slice(0, 30);
          const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000);
          const forms = [...document.querySelectorAll('form')].filter(visible);
          const submits = [...document.querySelectorAll('button[type="submit"], input[type="submit"], button')]
            .filter(visible)
            .filter((el) => /submit|apply|send|continue|отправ|отклик/i.test(textOf(el) || el.value || el.getAttribute('aria-label') || ''));
          return {
            url: location.href,
            bodyText,
            formCount: forms.length,
            submitCount: submits.length,
            requiredMissing: dedupRequired,
            validationErrors,
            nativeInvalidCount: controls.filter((el) => typeof el.checkValidity === 'function' && !el.checkValidity()).length
          };
        });
        frames.push(state);
      } catch {
        // A frame may detach while the SPA navigates; the next probe will see it.
      }
    }
    const bodyText = frames.map((f) => f.bodyText).filter(Boolean).join(' ').slice(0, 24000);
    return JSON.stringify({
      url: page.url(),
      urls: [...new Set(frames.map((f) => f.url).filter(Boolean))],
      title: await page.title(),
      bodyText,
      formCount: frames.reduce((n, f) => n + Number(f.formCount || 0), 0),
      submitCount: frames.reduce((n, f) => n + Number(f.submitCount || 0), 0),
      requiredMissing: frames.flatMap((f) => (f.requiredMissing || []).map((x) => ({ ...x, frame: f.url }))).slice(0, 40),
      validationErrors: [...new Set(frames.flatMap((f) => f.validationErrors || []))].slice(0, 40),
      nativeInvalidCount: frames.reduce((n, f) => n + Number(f.nativeInvalidCount || 0), 0)
    });
  }`;
}

function inspectPage(session, settleMs = 0) {
  const out = runCli(session, ['run-code', pageProbeCode(settleMs)], { raw: true, timeout: 40_000 }).stdout;
  const parsed = parseJsonish(out);
  if (!parsed || typeof parsed !== 'object') throw new Error('Playwright page probe returned non-object');
  return parsed;
}

function parseRequestList(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^#\s*(\d+)\.\s*\[([A-Z]+)\]\s+(\S+)\s+=>\s+\[([^\]]+)\]/);
    if (!m) continue;
    const statusText = m[4];
    rows.push({
      index: Number(m[1]),
      method: m[2],
      url: m[3],
      status: /^\d+$/.test(statusText) ? Number(statusText) : null,
      statusText,
    });
  }
  return rows;
}

function safeBody(session, command, index) {
  const res = runCli(session, [command, String(index)], {
    raw: true,
    timeout: 20_000,
    allowFailure: true,
  });
  return res.status === 0 ? res.stdout.slice(0, 80_000) : '';
}

function sanitizedRequestUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return String(raw || '').split(/[?#]/, 1)[0].slice(0, 1000);
  }
}

function inspectNetwork(session) {
  const raw = runCli(session, ['requests'], { raw: true, timeout: 20_000 }).stdout;
  const rows = parseRequestList(raw);
  const sanitized = [];
  for (const row of rows.slice(-60)) {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(row.method);
    let requestLooksLikeApplication = false;
    let responseLooksSuccess = false;
    let responseLooksError = false;
    if (mutating) {
      // Bodies are inspected IN MEMORY only. They may contain candidate PII and
      // are never written into the evidence receipt or audit log.
      const reqBody = safeBody(session, 'request-body', row.index);
      const resBody = safeBody(session, 'response-body', row.index);
      requestLooksLikeApplication = SUBMISSION_URL_RE.test(row.url) || SUBMISSION_BODY_RE.test(reqBody);
      responseLooksSuccess = RESPONSE_SUCCESS_RE.test(resBody);
      responseLooksError = RESPONSE_ERROR_RE.test(resBody);
    }
    sanitized.push({
      index: row.index,
      method: row.method,
      url: sanitizedRequestUrl(row.url),
      status: row.status,
      statusText: row.statusText,
      requestLooksLikeApplication,
      responseLooksSuccess,
      responseLooksError,
    });
  }
  // Do not persist the raw request listing: query strings can contain PII.
  return { requests: sanitized };
}

function hasSuccessText(text) {
  return SUCCESS_TEXT_RE.some((re) => re.test(String(text || '')));
}

export function classifyApplicationEvidence({ before = {}, after = {}, network = {} } = {}) {
  const body = String(after.bodyText || '');
  const blocked = BLOCKED_RE.test(body);
  const explicitFailure = FAILURE_TEXT_RE.test(body);
  const errors = Array.isArray(after.validationErrors) ? after.validationErrors.filter(Boolean) : [];
  const invalid = Number(after.nativeInvalidCount || 0);
  // A generic application page can already contain "thank you for applying"
  // copy before Submit. Text only counts when it appears after the attempt;
  // a success-shaped destination URL is independently strong.
  const beforeUrls = new Set([
    String(before.url || ''),
    ...(Array.isArray(before.urls) ? before.urls.map(String) : []),
  ].filter(Boolean));
  const afterUrls = [
    String(after.url || ''),
    ...(Array.isArray(after.urls) ? after.urls.map(String) : []),
  ].filter(Boolean);
  const newSuccessUrl = afterUrls.some((url) => SUCCESS_URL_RE.test(url) && !beforeUrls.has(url));
  const strongUiSuccess = newSuccessUrl
    || (hasSuccessText(body) && !hasSuccessText(String(before.bodyText || '')));
  const rows = Array.isArray(network.requests) ? network.requests : [];
  const candidateRequests = rows.filter((r) => r
    && !['GET', 'HEAD', 'OPTIONS'].includes(String(r.method || '').toUpperCase())
    && (r.requestLooksLikeApplication || r.responseLooksSuccess || SUBMISSION_URL_RE.test(String(r.url || ''))));
  const networkSuccess = candidateRequests.some((r) => r.status != null && r.status >= 200 && r.status < 400 && !r.responseLooksError);
  const networkFailure = candidateRequests.some((r) => r.status != null && r.status >= 400);
  const formGone = Number(before.formCount || 0) > 0 && Number(after.formCount || 0) === 0;
  const urlChanged = Boolean(before.url && after.url && before.url !== after.url);

  if (strongUiSuccess && !blocked) {
    return {
      outcome: 'applied',
      confidence: networkSuccess ? 'high' : 'medium',
      signals: { strongUiSuccess, networkSuccess, formGone, urlChanged },
    };
  }
  if (blocked) {
    return { outcome: 'blocked', confidence: 'high', signals: { blocked: true, networkSuccess } };
  }
  if (errors.length || invalid > 0) {
    return {
      outcome: 'validation_failed',
      confidence: 'high',
      signals: { errors: errors.length, invalid, networkSuccess },
    };
  }
  if (explicitFailure || networkFailure) {
    return {
      outcome: 'failed',
      confidence: 'high',
      signals: { explicitFailure, networkFailure, networkSuccess },
    };
  }
  if (networkSuccess || formGone || urlChanged) {
    return {
      outcome: 'submitted_unconfirmed',
      confidence: networkSuccess ? 'medium' : 'low',
      signals: { networkSuccess, formGone, urlChanged },
    };
  }
  return {
    outcome: 'submitted_unconfirmed',
    confidence: 'low',
    signals: { networkSuccess: false, formGone: false, urlChanged: false },
  };
}

function receiptDir(urlKey) {
  const id = createHash('sha256').update(urlKey).digest('hex').slice(0, 16);
  return path.join(EVIDENCE_ROOT, id);
}

function assertEvidencePath(raw) {
  const abs = path.resolve(String(raw || ''));
  const rel = path.relative(EVIDENCE_ROOT, abs);
  if (!raw || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`evidence receipt must be under ${EVIDENCE_ROOT}`);
  }
  return abs;
}

export function loadEvidenceReceipt(rawPath) {
  const abs = assertEvidencePath(rawPath);
  if (!existsSync(abs)) throw new Error(`evidence receipt not found: ${abs}`);
  const parsed = JSON.parse(readFileSync(abs, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid evidence receipt');
  return { path: abs, receipt: parsed };
}

export function evidenceMatchesOutcome(receipt, jobUrlKey, expectedOutcome) {
  if (!receipt || receipt.phase !== 'verified') return { ok: false, reason: 'receipt_not_verified' };
  if (receipt.job_url_key !== jobUrlKey) return { ok: false, reason: 'receipt_job_mismatch' };
  const actual = receipt.verification?.outcome;
  if (expectedOutcome === 'captcha') {
    return actual === 'blocked' ? { ok: true } : { ok: false, reason: `receipt_outcome_${actual}` };
  }
  return actual === expectedOutcome ? { ok: true } : { ok: false, reason: `receipt_outcome_${actual}` };
}

function screenshot(session, filename) {
  return runCli(session, ['screenshot', `--filename=${filename}`], {
    timeout: 30_000,
    allowFailure: true,
  });
}

export function beginVerification(target, { session = DEFAULT_SESSION } = {}) {
  const jobUrlKey = normalizeUrlKey(target);
  if (!jobUrlKey) throw new Error('begin requires a valid http(s) job URL');
  const s = safeSession(session);
  const before = inspectPage(s);
  if ((before.requiredMissing?.length || 0) > 0 || Number(before.nativeInvalidCount || 0) > 0) {
    const names = (before.requiredMissing || [])
      .map((x) => x.name || x.type || x.tag)
      .filter(Boolean)
      .slice(0, 8);
    throw new Error(
      `pre-submit validation failed: ${before.requiredMissing?.length || 0} required field(s) missing, nativeInvalid=${before.nativeInvalidCount || 0}`
      + (names.length ? ` [${names.join(', ')}]` : ''),
    );
  }

  runCli(s, ['requests', '--clear'], { raw: true, timeout: 20_000 });
  const traceStart = runCli(s, ['tracing-start'], { timeout: 20_000, allowFailure: true });

  const dir = receiptDir(jobUrlKey);
  mkdirSync(dir, { recursive: true });
  const attemptId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const beforeShot = path.join(dir, `${attemptId}-before.png`);
  screenshot(s, beforeShot);

  const receiptPath = path.join(dir, `${attemptId}.json`);
  const receipt = {
    version: 1,
    phase: 'armed',
    attempt_id: attemptId,
    job_url_key: jobUrlKey,
    session: s,
    started_at: new Date().toISOString(),
    before,
    artifacts: {
      before_screenshot: beforeShot,
      trace_start: String(traceStart.stdout || '').trim().slice(0, 2000),
    },
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
  auditLog('submit_evidence_armed', {
    job_url_key: jobUrlKey,
    session: s,
    attempt_id: attemptId,
  });
  return { receiptPath, receipt };
}

export function finishVerification(receiptPath) {
  const { path: abs, receipt } = loadEvidenceReceipt(receiptPath);
  if (receipt.phase !== 'armed') {
    throw new Error(`receipt is not armed (phase=${receipt.phase || 'unknown'})`);
  }
  const s = safeSession(receipt.session);
  // Give SPA mutations, validation banners and redirects a short deterministic
  // settle window before classifying the post-submit state.
  const after = inspectPage(s, 2_000);
  const network = inspectNetwork(s);
  const afterShot = abs.replace(/\.json$/i, '-after.png');
  screenshot(s, afterShot);
  const traceStop = runCli(s, ['tracing-stop'], {
    timeout: 30_000,
    allowFailure: true,
  });
  const verification = classifyApplicationEvidence({ before: receipt.before, after, network });

  const finished = {
    ...receipt,
    phase: 'verified',
    finished_at: new Date().toISOString(),
    after,
    network,
    verification,
    artifacts: {
      ...receipt.artifacts,
      after_screenshot: afterShot,
      trace_stop: String(traceStop.stdout || '').trim().slice(0, 3000),
    },
  };
  writeFileSync(abs, JSON.stringify(finished, null, 2), 'utf8');
  auditLog('submit_evidence_verified', {
    job_url_key: receipt.job_url_key,
    attempt_id: receipt.attempt_id,
    outcome: verification.outcome,
    confidence: verification.confidence,
  });
  return { receiptPath: abs, receipt: finished };
}

function doctor() {
  const cli = checkPlaywrightCli();
  const out = {
    ok: cli.ok,
    cli,
    session: DEFAULT_SESSION,
    profile: DEFAULT_PROFILE,
    recommended_open:
      `npx playwright cli -s=${DEFAULT_SESSION} open <url> --browser=chrome --profile="${DEFAULT_PROFILE}" --headed`,
  };
  console.log(JSON.stringify(out, null, 2));
  return cli.ok;
}

function usage() {
  console.log(`Usage:
  node autopilot-verify.mjs doctor
  node autopilot-verify.mjs begin "<job-url>" [--session name]
  node autopilot-verify.mjs finish "<receipt-path>"
  node autopilot-verify.mjs classify "<fixture.json>"`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'doctor') {
    process.exitCode = doctor() ? 0 : 1;
    return;
  }
  if (cmd === 'begin') {
    const result = beginVerification(argv[1], {
      session: flagValue(argv, '--session') || DEFAULT_SESSION,
    });
    console.log(JSON.stringify({
      receipt: result.receiptPath,
      ready_for_submit: true,
      before: result.receipt.before,
    }, null, 2));
    return;
  }
  if (cmd === 'finish') {
    const result = finishVerification(argv[1]);
    console.log(JSON.stringify({
      receipt: result.receiptPath,
      verification: result.receipt.verification,
      after: result.receipt.after,
    }, null, 2));
    return;
  }
  if (cmd === 'classify') {
    if (!argv[1]) throw new Error('classify requires a JSON fixture path');
    const fixture = JSON.parse(readFileSync(path.resolve(argv[1]), 'utf8'));
    console.log(JSON.stringify(classifyApplicationEvidence(fixture), null, 2));
    return;
  }
  usage();
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`autopilot-verify: ${err?.message || err}`);
    process.exit(1);
  });
}
