#!/usr/bin/env node
// scan-regional.mjs — one command that combines the regional source registry
// with the existing scanner.
//
// Default: cheap path. Re-export already known source/company boards and scan.
// --refresh: refresh official company directories, health, career discovery and
// ATS resolution first, then scan the generated regional portals file.
//
// No job/company/application count ceiling is introduced here. Refresh
// concurrency exists only to avoid hammering third-party sites simultaneously.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const GENERATED = process.env.CAREER_OPS_EXPANDED_PORTALS
  || path.join(DATA_ROOT, 'data', 'portals-regional.generated.yml');

function runNode(script, args = [], extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(script + ' exited with status ' + res.status);
}

function parse(argv) {
  const refresh = argv.includes('--refresh');
  const dryRun = argv.includes('--dry-run');
  const noTg = argv.includes('--no-tg');
  const idx = argv.indexOf('--country');
  const eq = argv.find((a) => a.startsWith('--country='));
  const country = String(eq ? eq.slice('--country='.length) : (idx >= 0 ? argv[idx + 1] : '')).trim().toUpperCase() || null;
  if (country && !['RU', 'KZ', 'AM', 'UZ'].includes(country)) throw new Error('country must be RU, KZ, AM, or UZ');
  const allowed = new Set(['--refresh', '--dry-run', '--no-tg', '--country']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--country') { i += 1; continue; }
    if (a.startsWith('--country=')) continue;
    if (!allowed.has(a)) throw new Error('unknown argument: ' + a);
  }
  return { refresh, dryRun, noTg, country };
}

function main() {
  const opts = parse(process.argv.slice(2));
  const countryArgs = opts.country ? ['--country', opts.country] : [];

  if (opts.refresh) {
    runNode('source-registry.mjs', ['full', ...countryArgs]);
  } else {
    runNode('source-registry.mjs', ['init']);
    runNode('source-registry.mjs', ['export', ...countryArgs]);
  }

  // Keep the scanner as the one canonical ingestion path. It receives the
  // generated catalog as an env override while every other user-owned config
  // file remains untouched.
  const scanArgs = [];
  runNode('scan.mjs', scanArgs, { CAREER_OPS_PORTALS: GENERATED });

  // Queue newly scanned jobs into the autonomous execution DB without running a
  // second network scan. Autopilot title/location gates remain deterministic.
  const autopilotArgs = ['--no-scan'];
  if (opts.dryRun) autopilotArgs.push('--dry-run');
  if (opts.noTg) autopilotArgs.push('--no-tg');
  runNode('autopilot.mjs', autopilotArgs, { CAREER_OPS_PORTALS: GENERATED });

  console.log('');
  console.log('regional scan complete');
  console.log('  portals: ' + GENERATED);
  console.log('  source discovery queue: ' + path.join(DATA_ROOT, 'data', 'source-discovery-queue.md'));
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error('scan-regional: ' + (err?.message || err));
    process.exit(1);
  }
}
