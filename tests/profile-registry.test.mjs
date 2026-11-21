// tests/profile-registry.test.mjs — registry for the multi-account model
// (profiles → directions): validation, persistence roundtrip, path/naming
// rules that keep direction workers, sessions and data roots from colliding.
//
// Run:  node --test tests/profile-registry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizeRegistry, saveProfiles, loadProfiles, isValidId, slugify,
  directionRoot, directionRootRelative, profileRoot, workerIdFor, sessionNameFor,
} from '../lib/profile-registry.mjs';

test('isValidId accepts slugs and rejects everything a shell or claim id would choke on', () => {
  assert.equal(isValidId('maxim'), true);
  assert.equal(isValidId('react-dev'), true);
  assert.equal(isValidId('a1'), true);
  assert.equal(isValidId('Maxim'), false); // uppercase
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('-x'), false); // leading hyphen
  assert.equal(isValidId('x--y'), false); // double hyphen
  assert.equal(isValidId('a'.repeat(41)), false); // too long for session composition
  assert.equal(isValidId('re act'), false);
});

test('slugify makes valid ids from display names, latin and cyrillic', () => {
  assert.equal(slugify('Data Analyst'), 'data-analyst');
  assert.equal(slugify('React / Vue Developer!'), 'react-vue-developer');
  assert.equal(slugify('Дизайнер'), 'dizayner');
  assert.equal(slugify('---'), null); // nothing left → caller must pick an id
});

test('normalizeRegistry coerces numeric telegram ids and fills defaults', () => {
  const reg = normalizeRegistry({
    profiles: [{ id: 'maxim', telegram: [{ user_id: 4242 }], directions: [{ id: 'analyst' }] }],
  });
  assert.equal(reg.profiles[0].telegram[0].user_id, '4242');
  assert.equal(reg.profiles[0].admin ?? undefined, undefined);
  assert.equal(reg.profiles[0].directions[0].name, 'analyst');
  assert.equal(reg.profiles[0].name, 'maxim');
});

test('normalizeRegistry rejects the shapes that would break identity or isolation', () => {
  const bad = [
    [{ profiles: [{ id: 'a' }, { id: 'a' }] }, 'duplicate profile'],
    [{ profiles: [{ id: 'a', directions: [{ id: 'x' }, { id: 'x' }] }] }, 'duplicate direction'],
    [{ profiles: [
      { id: 'a', telegram: [{ user_id: '1' }] },
      { id: 'b', telegram: [{ user_id: '1' }] },
    ] }, 'one telegram id in two profiles'],
    [{ profiles: [{ id: 'a', telegram: [{ user_id: 'not-a-number' }] }] }, 'non-numeric tg id'],
    [{ profiles: [{ id: 'Bad Slug' }] }, 'invalid slug'],
    [{ profiles: 'nope' }, 'profiles not a list'],
  ];
  for (const [input, label] of bad) {
    assert.throws(() => normalizeRegistry(input), Error, label);
  }
});

test('saveProfiles/loadProfiles roundtrip through a temp registry file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profiles-reg-'));
  const file = join(dir, 'profiles.yml');
  try {
    saveProfiles({ profiles: [{ id: 'maxim', name: 'Maxim', telegram: [{ user_id: '4242', admin: true }], directions: [{ id: 'analyst', name: 'Data Analyst', created: '2026-09-23' }] }] }, { registryFile: file });
    const loaded = loadProfiles({ registryFile: file });
    assert.deepEqual(loaded.profiles[0].directions, [{ id: 'analyst', name: 'Data Analyst', created: '2026-09-23' }]);
    assert.equal(loaded.profiles[0].telegram[0].admin, true);
    // normalizeRegistry runs on save AND load, so the file on disk is always valid
    assert.throws(() => saveProfiles({ profiles: [{ id: 'X' }] }, { registryFile: file }), /invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProfiles returns null for a missing registry (deny-by-default stays a caller decision)', () => {
  assert.equal(loadProfiles({ registryFile: join(tmpdir(), 'no-such-profiles-42.yml') }), null);
});

test('direction and profile roots land under data/profiles of the given data root', () => {
  const root = directionRoot('maxim', 'analyst', { dataRoot: 'C:/base' });
  assert.equal(root, join('C:/base', 'data', 'profiles', 'maxim', 'analyst'));
  assert.equal(profileRoot('maxim', { dataRoot: 'C:/base' }), join('C:/base', 'data', 'profiles', 'maxim'));
  assert.throws(() => directionRoot('Bad', 'analyst'), /invalid profile id/);
});

test('worker/session names satisfy autopilot constraints', () => {
  assert.equal(workerIdFor('maxim', 'analyst'), 'maxim-analyst');
  const session = sessionNameFor('a'.repeat(30), 'b'.repeat(30)); // max valid slugs
  assert.match(session, /^[A-Za-z0-9_.-]{1,80}$/); // autopilot-verify safeSession()
});

test('directionRootRelative returns a code-root-relative posix path', () => {
  const rel = directionRootRelative('maxim', 'analyst', { dataRoot: 'C:/base', codeRoot: 'C:/base' });
  assert.equal(rel, 'data/profiles/maxim/analyst');
});
