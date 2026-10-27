#!/usr/bin/env node
// Allowlisted diagnostics exporter. Safe to attach to a public issue only
// after reviewing the output; raw data/, browser profile, traces stay local.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const RPT = path.join(getCareerOpsRoot(), 'data', 'autopilot', 'reports');
const MAX = 30;
const COUNTERS = new Set(['claimed', 'applied', 'submitted_unconfirmed', 'deferred', 'captcha', 'failed', 'skipped', 'no_outcome']);
const STATES = new Set(['queued', 'claimed', 'applied', 'submitted_unconfirmed', 'validation_failed', 'failed', 'captcha', 'skipped']);
const AGENTS = new Set(['claude', 'codex', 'opencode']);
function safeCounts(v, allowed) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [key, n] of Object.entries(v)) {
    if (allowed.has(key) && Number.isSafeInteger(n) && n >= 0) out[key] = n;
  }
  return out;
}
export function publicDiagnostic(report) {
  if (!report || typeof report !== 'object') throw new Error('invalid report');
  return {
    version: 1,
    started_at: /^\d{4}-\d{2}-\d{2}T/.test(String(report.started_at)) ? report.started_at : null,
    duration_ms: Number.isSafeInteger(report.duration_ms) && report.duration_ms >= 0 ? report.duration_ms : null,
    agent: AGENTS.has(report.agent) ? report.agent : null,
    ok: report.ok === true,
    error_code: report.error_code === 'RUNNER_FAILED' ? 'RUNNER_FAILED' : null,
    counts: safeCounts(report.counts, COUNTERS),
    queue: safeCounts(report.queue, STATES),
  };
}
export function exportDiagnostics({ limit = 10 } = {}) {
  if (!existsSync(RPT)) return { version: 1, runs: [] };
  const files = readdirSync(RPT).filter(n => /^[a-z0-9._-]+\.json$/i.test(n)).sort().reverse().slice(0, Math.min(limit, MAX));
  const runs = [];
  for (const name of files) {
    try { runs.push(publicDiagnostic(JSON.parse(readFileSync(path.join(RPT, name), 'utf8')))); }
    catch { runs.push({ version: 1, error_code: 'BAD_LOCAL_REPORT' }); }
  }
  return { version: 1, generated_at: new Date().toISOString(), runs };
}
if (isMainModule(import.meta.url)) {
  try {
    const n = Number(process.argv[2] || 10);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX) throw new Error('limit must be 1..30');
    const data = JSON.stringify(exportDiagnostics({ limit: n }), null, 2) + '\n';
    if (process.argv[3] === '--output') {
      const filename = process.argv[4];
      if (!filename || !/^[a-z0-9._-]+\.json$/i.test(filename)) throw new Error('output must be a simple JSON filename');
      const dest = path.join(getCareerOpsRoot(), filename);
      writeFileSync(dest, data, { flag: 'wx', mode: 0o600 });
      console.log('Sanitized diagnostic report: ' + dest);
    } else console.log(data);
  } catch (e) { console.error('diagnostics: ' + e.message); process.exitCode = 1; }
}
