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

test('README documents the fork autopilot as explicit opt-in', () => {
  assert.match(readme, /fork-autopilot: explicit opt-in autonomous submit/);
  assert.match(readme, /first live run of a new site or form type is fill-only/i);
});
