// tests/profile-stats-data-root.test.mjs — a direction's stats come from ITS
// data root, not the checkout's: computeAllStats with explicit per-root files,
// cross-direction recent rows, and the load-bearing regression that report
// numbers allocate under CAREER_OPS_ROOT (a direction root) — the guarantee
// profile.mjs/autopilot rely on when they reserve numbers per direction.
//
// Run:  node --test tests/profile-stats-data-root.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { computeDirectionStats, readProfileRecentRows } from '../lib/profile-stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

const TRACKER_HEADER = '# Applications Tracker\n\n'
  + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
  + '|---|------|---------|------|-------|--------|-----|--------|-------|\n';

function directionRootWith(rows) {
  const root = mkdtempSync(join(tmpdir(), 'profile-stats-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), TRACKER_HEADER + rows.join('\n') + '\n', 'utf-8');
  return root;
}

test('computeDirectionStats reads the tracker under the given root; missing root → null', () => {
  const root = directionRootWith([
    '| 1 | 2026-09-20 | Acme | Data Engineer | 4.0/5 | Applied | ❌ | — | n |',
    '| 2 | 2026-09-21 | Globex | Analyst | 3.5/5 | Interview | ❌ | — | n |',
    '| 3 | 2026-09-22 | Initech | Analyst | 3.0/5 | SKIP | ❌ | — | n |',
  ]);
  try {
    const stats = computeDirectionStats(root);
    assert.equal(stats.tracker.total, 3);
    assert.equal(stats.tracker.byStatus.Applied, 1);
    assert.equal(stats.tracker.byStatus.SKIP, 1);
    assert.equal(stats.funnel.everApplied, 2); // Applied + Interview
    assert.equal(stats.funnel.everInterview, 1);
    assert.equal(stats.metadata.sources.tracker, true);
    assert.equal(computeDirectionStats(join(root, 'no-such-direction')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readProfileRecentRows merges directions newest-first and tags each row', () => {
  const older = directionRootWith(['| 1 | 2026-09-01 | OldCo | A | 3/5 | Applied | ❌ | — | n |']);
  const newer = directionRootWith([
    '| 1 | 2026-09-22 | NewCo | B | 3/5 | Applied | ❌ | — | n |',
    '| 2 | 2026-09-23 | NewCo2 | C | 3/5 | Interview | ❌ | — | n |',
  ]);
  try {
    const rows = readProfileRecentRows({ react: older, analyst: newer }, 3);
    assert.deepEqual(rows.map((r) => `${r.direction}:${r.company}`), ['analyst:NewCo2', 'analyst:NewCo', 'react:OldCo']);
  } finally {
    rmSync(older, { recursive: true, force: true });
    rmSync(newer, { recursive: true, force: true });
  }
});

test('reserve-report-num allocates from reports/ under CAREER_OPS_ROOT (the direction-root guarantee)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rrn-dirroot-'));
  mkdirSync(join(dir, 'reports'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'applications.md'), TRACKER_HEADER, 'utf-8');
  // Occupancy ONLY inside the direction root: 005 exists there, and nothing
  // from this checkout's real reports/ may influence the allocation.
  writeFileSync(join(dir, 'reports', '005-acme-2026-09-01.md'), '# x\n', 'utf-8');
  try {
    const res = spawnSync(NODE, [join(ROOT, 'reserve-report-num.mjs')], {
      encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_ROOT: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '006');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
