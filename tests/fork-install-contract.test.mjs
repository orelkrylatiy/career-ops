import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const README = readFileSync('README.md', 'utf8');
const CLI = readFileSync('scaffolder/bin/cli.mjs', 'utf8');
const ROOT_PACKAGE = JSON.parse(readFileSync('package.json', 'utf8'));
const SCAFFOLDER_PACKAGE = JSON.parse(readFileSync('scaffolder/package.json', 'utf8'));
const UPDATE = readFileSync('update-system.mjs', 'utf8');
const SETUP = readFileSync('docs/SETUP.md', 'utf8');
const SCAFFOLDER_README = readFileSync('scaffolder/README.md', 'utf8');

test('fork Quick Start installs the fork and does not recommend upstream npx installer', () => {
  const quick = README.slice(README.indexOf('## Quick Start'), README.indexOf('\n## ', README.indexOf('## Quick Start') + 5));
  assert.match(quick, /git clone https:\/\/github\.com\/orelkrylatiy\/career-ops\.git/);
  assert.doesNotMatch(quick, /npx @santifer\/career-ops init/);
});

test('local scaffolder clones the autonomous fork', () => {
  assert.match(CLI, /https:\/\/github\.com\/orelkrylatiy\/career-ops\.git/);
  assert.match(CLI, /api\.github\.com\/repos\/orelkrylatiy\/career-ops\/releases\/latest/);
  assert.doesNotMatch(CLI, /career-ops-hq\/career-ops/);
});

test('package metadata points at the fork', () => {
  assert.equal(ROOT_PACKAGE.repository.url, 'https://github.com/orelkrylatiy/career-ops');
  assert.equal(SCAFFOLDER_PACKAGE.repository.url, 'git+https://github.com/orelkrylatiy/career-ops.git');
});

test('updater checks and fetches fork main', () => {
  assert.match(UPDATE, /CANONICAL_REPO = 'https:\/\/github\.com\/orelkrylatiy\/career-ops\.git'/);
  assert.match(UPDATE, /api\.github\.com\/repos\/orelkrylatiy\/career-ops\/git\/ref\/heads\/main/);
});

test('setup docs do not route autonomous-fork users through upstream npm installer', () => {
  assert.match(SETUP, /git clone https:\/\/github\.com\/orelkrylatiy\/career-ops\.git/);
  const recommended = SETUP.slice(
    SETUP.indexOf('### Recommended'),
    SETUP.indexOf('### Advanced', SETUP.indexOf('### Recommended')),
  );
  assert.doesNotMatch(recommended, /npx @santifer\/career-ops init/);
});

test('scaffolder README clearly identifies the npm package as upstream-only', () => {
  assert.match(SCAFFOLDER_README, /public npm package .* upstream/is);
  assert.match(SCAFFOLDER_README, /git clone https:\/\/github\.com\/orelkrylatiy\/career-ops\.git/);
});

test('fork scaffolder enforces the same Node floor as the autonomous runtime', () => {
  assert.equal(SCAFFOLDER_PACKAGE.engines.node, '>=20');
  assert.match(CLI, /requires Node\.js 20\+/);
});
