import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { browserProfilePath } from '../lib/browser-profile.mjs';

const checkout = path.resolve('/virtual', 'career-ops');
const directionRoot = path.join(checkout, 'data', 'profiles', 'alice', 'react');

test('default browser profile lives under this direction', () => {
  assert.equal(browserProfilePath({ directionRoot, codeRoot: checkout }),
    path.join(directionRoot, 'data', 'browser-profile'));
});
test('external browser store is scoped to each person and direction', () => {
  const store = path.resolve('/virtual', 'browser-store');
  const env = { CAREER_OPS_BROWSER_STORE_ROOT: store };
  const paths = [
    browserProfilePath({ directionRoot, person: 'alice', direction: 'react', env, codeRoot: checkout }),
    browserProfilePath({ directionRoot, person: 'alice', direction: 'vue', env, codeRoot: checkout }),
    browserProfilePath({ directionRoot, person: 'bob', direction: 'react', env, codeRoot: checkout }),
  ];
  assert.deepEqual(paths, [path.join(store, 'alice', 'react'), path.join(store, 'alice', 'vue'), path.join(store, 'bob', 'react')]);
  assert.equal(new Set(paths).size, 3);
});
test('external browser storage inside repo or with invalid identity is rejected', () => {
  assert.throws(() => browserProfilePath({ directionRoot, person: 'alice', direction: 'react',
    env: { CAREER_OPS_BROWSER_STORE_ROOT: path.join(checkout, 'browsers') }, codeRoot: checkout }), /outside the source checkout/);
  assert.throws(() => browserProfilePath({ directionRoot, person: 'alice', direction: '../bob',
    env: { CAREER_OPS_BROWSER_STORE_ROOT: '/virtual/browsers' }, codeRoot: checkout }), /valid candidate\/direction/);
});

test('browser-store symlink cannot point into checkout through an absent child folder', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'career-ops-browser-symlink-'));
  try {
    const repo = path.join(dir, 'checkout');
    mkdirSync(repo);
    const alias = path.join(dir, 'external-alias');
    symlinkSync(repo, alias, 'dir');
    assert.throws(() => browserProfilePath({
      directionRoot: path.join(repo, 'data', 'profiles', 'alice', 'react'),
      person: 'alice', direction: 'react', codeRoot: repo,
      env: { CAREER_OPS_BROWSER_STORE_ROOT: path.join(alias, 'new-browser-store') },
    }), /outside the source checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
