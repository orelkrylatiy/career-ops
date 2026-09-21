import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('README keeps default review-first behavior explicit', () => {
  assert.match(readme, /default Career-Ops modes remain review-first/i);
});

test('README documents the fork autopilot as explicit autonomous opt-in', () => {
  assert.match(readme, /fork-autopilot: wide-funnel autonomous submit/);
  assert.match(readme, /wide-funnel discovery/i);
  assert.match(readme, /deterministic post-submit evidence/i);
});
