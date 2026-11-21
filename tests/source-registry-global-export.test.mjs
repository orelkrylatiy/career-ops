import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';

test('source registry full export includes curated global board-wide providers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-global-export-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  try {
    const result = spawnSync(process.execPath, ['source-registry.mjs', 'export'], {
      cwd: process.cwd(),
      env: { ...process.env, CAREER_OPS_ROOT: root },
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      0,
      String(result.stderr || result.stdout || result.error?.message || ''),
    );

    const generated = yaml.load(
      readFileSync(path.join(root, 'data', 'portals-regional.generated.yml'), 'utf8'),
    );
    const providers = new Set(
      (generated.job_boards || []).map((row) => String(row.provider || '')),
    );
    for (const provider of [
      'himalayas',
      'jobicy',
      'arbeitnow',
      '4dayweek',
      'hackernews',
      'cryptocurrencyjobs',
      'remotive',
      'remoteok',
      'workingnomads',
      'weworkremotely',
      'nodesk',
      'jobspresso',
    ]) {
      assert.equal(providers.has(provider), true, provider);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
