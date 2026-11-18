#!/usr/bin/env node
/**
 * Autopilot discovery adapter for CareerOps 1.40+.
 * Preserve upstream's unmodified scanner and provider fixes.
 * For autonomous runs only, use a temporary filter-free portals.yml.
 * Fit preferences rank jobs downstream rather than dropping them here.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOFT_FILTERS = [
  'title_filter', 'title_filter_full', 'title_filter_overrides',
  'location_filter', 'max_posting_age_days', 'skip_tiers',
  'salary_filter', 'employment_type_filter', 'workplace_filter',
  'country_eligibility_filter', 'visa_filter', 'content_filter',
  'experience_filter', 'field_filters', 'domain_filter',
  'preferred_languages', 'location_hints',
];

export function isExcludedTransport(item) {
  if (!item || typeof item !== 'object') return false;
  if (String(item.provider || item.type || item.ats || '').toLowerCase() === 'telegram-channel') return true;
  for (const field of ['url', 'board_url', 'careers_url', 'source', 'domain', 'host']) {
    const value = String(item[field] || '').trim();
    if (!value) continue;
    try {
      const host = new URL(value.includes('://') ? value : 'https://' + value).hostname.toLowerCase();
      if (/(^|\.)hh\.(ru|kz|uz)$/.test(host)) return true;
    } catch { /* non-URL string, not an exclusion match */ }
  }
  return false;
}

export function makeWideConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('portals.yml must contain a YAML mapping');
  }
  const config = structuredClone(raw);
  for (const key of SOFT_FILTERS) delete config[key];
  for (const field of ['tracked_companies', 'job_boards']) {
    if (Array.isArray(config[field])) config[field] = config[field].filter(item => !isExcludedTransport(item));
  }
  return config;
}

export function parseScanArgs(argv) {
  const args = [...argv];
  const atsFull = args[0] === '--ats-full';
  if (atsFull) args.shift();
  if (args.includes('--wide')) throw new Error('obsolete --wide: the adapter already constructs a wide configuration');
  return { atsFull, args };
}

export function main(argv = process.argv.slice(2)) {
  const { atsFull, args } = parseScanArgs(argv);
  const portals = process.env.CAREER_OPS_PORTALS || path.join(getCareerOpsRoot(), 'portals.yml');
  const base = yaml.load(readFileSync(portals, 'utf8'));
  const wide = makeWideConfig(base);
  const tempDir = mkdtempSync(path.join(tmpdir(), 'careerops-wide-'));
  const tempConfig = path.join(tempDir, 'portals.yml');
  try {
    writeFileSync(tempConfig, yaml.dump(wide), { mode: 0o600 });
    const target = path.join(CODE_ROOT, atsFull ? 'scan-ats-full.mjs' : 'scan.mjs');
    const result = spawnSync(process.execPath, [target, ...args], {
      cwd: CODE_ROOT, stdio: 'inherit', shell: false,
      env: { ...process.env, CAREER_OPS_PORTALS: tempConfig },
      timeout: Number(process.env.AUTOPILOT_SCAN_TIMEOUT_MS) || 45 * 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('upstream scanner exited ' + result.status);
    return 0;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) {
    console.error('[autopilot-scan] ' + error.message);
    process.exitCode = 1;
  }
}
