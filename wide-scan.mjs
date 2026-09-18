#!/usr/bin/env node
/**
 * wide-scan.mjs — broad discovery orchestrator for this fork.
 *
 * Combines:
 *  1) versioned regional employer seeds -> ATS discovery -> portals.yml
 *  2) normal curated scan.mjs
 *  3) reverse public ATS sweep + VC seeds
 *  4) browser-only/local aggregators -> data/market-board-queue.md
 *
 * No employer/application count limit is imposed here. Time/cache thresholds
 * only avoid repeating expensive network discovery on every short autopilot loop.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { loadMarketRegistry } from './market-sources.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const STATE_FILE = path.join(DATA_ROOT, 'data', 'wide-scan-state.json');
const BOARD_QUEUE = path.join(DATA_ROOT, 'data', 'market-board-queue.md');

function flagValue(argv, name, fallback = null) {
  const eq = argv.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function runNode(script, args = [], { optional = false } = {}) {
  const run = spawnSync(process.execPath, [path.join(CODE_ROOT, script), ...args], {
    cwd: CODE_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (run.error) {
    if (optional) { console.error(`wide-scan: optional ${script} failed to spawn: ${run.error.message}`); return false; }
    throw run.error;
  }
  if (run.status !== 0) {
    if (optional) { console.error(`wide-scan: optional ${script} exited ${run.status}; continuing`); return false; }
    throw new Error(`${script} exited ${run.status}`);
  }
  return true;
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function isFresh(iso, maxAgeMs) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) && Date.now() - t < maxAgeMs;
}

function writeState(state) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, STATE_FILE);
}

export function renderBoardQueue(registry) {
  const lines = [
    '# Market Board Queue',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'These sources are intentionally retained even when no stable public API/provider exists.',
    'The browser agent should search them by target keywords and feed concrete job URLs back into the normal pipeline.',
    '',
  ];
  for (const country of ['RU', 'KZ', 'AM', 'UZ']) {
    const sources = registry.aggregators.filter(s => s.country === country);
    if (!sources.length) continue;
    lines.push(`## ${country}`);
    lines.push('');
    for (const source of sources) {
      lines.push(`- [ ] ${source.name} | ${source.url} | access=${source.access || 'browser'} | languages=${(source.languages || []).join(',')}`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function refreshBoardQueue(countries) {
  const registry = loadMarketRegistry(countries);
  mkdirSync(path.dirname(BOARD_QUEUE), { recursive: true });
  writeFileSync(BOARD_QUEUE, renderBoardQueue(registry), 'utf8');
}

function usage() {
  console.log([
    'Usage: node wide-scan.mjs [options]',
    '  --countries RU,KZ,AM,UZ   regional seed subset (default all)',
    '  --since DAYS              reverse ATS freshness window (default 30)',
    '  --force-discover          re-probe company ATS even if refreshed recently',
    '  --force-reverse           rerun reverse ATS sweep even if refreshed recently',
    '  --skip-reverse            skip global reverse ATS/VC sweep',
    '  --dry-run                 pass dry-run to scan stages that support it',
  ].join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) { usage(); return; }
  const countries = flagValue(argv, '--countries', 'RU,KZ,AM,UZ');
  const countryArgs = ['--countries', countries];
  const since = flagValue(argv, '--since', '30');
  if (!/^\d+$/.test(String(since)) || Number(since) < 1) throw new Error('--since must be a positive integer');

  const state = readState();
  const discoverFresh = isFresh(state.market_discover_at, 24 * 60 * 60 * 1000);
  const reverseFresh = isFresh(state.reverse_ats_at, 6 * 60 * 60 * 1000);

  refreshBoardQueue(countries.split(',').map(c => c.trim().toUpperCase()).filter(Boolean));

  if (hasFlag(argv, '--force-discover') || !discoverFresh) {
    runNode('market-sources.mjs', ['discover', ...countryArgs]);
    state.market_discover_at = new Date().toISOString();
    writeState(state);
  } else {
    console.error('wide-scan: regional ATS discovery cache is fresh; use --force-discover to re-probe');
  }

  const scanArgs = hasFlag(argv, '--dry-run') ? ['--dry-run'] : [];
  runNode('scan.mjs', scanArgs);

  if (!hasFlag(argv, '--skip-reverse') && (hasFlag(argv, '--force-reverse') || !reverseFresh)) {
    const reverseArgs = ['--since', String(since), '--seeds', 'yc,a16z'];
    if (hasFlag(argv, '--dry-run')) reverseArgs.push('--dry-run');
    // Reverse sweep is additive. A transient source failure should not erase
    // results already collected by regional/curated scans.
    if (runNode('scan-ats-full.mjs', reverseArgs, { optional: true })) {
      state.reverse_ats_at = new Date().toISOString();
      writeState(state);
    }
  } else if (!hasFlag(argv, '--skip-reverse')) {
    console.error('wide-scan: reverse ATS cache is fresh; use --force-reverse to rerun');
  }

  console.log(`wide-scan complete; browser source queue: ${BOARD_QUEUE}`);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('wide-scan: ' + (err?.message ?? err));
    process.exit(1);
  });
}
