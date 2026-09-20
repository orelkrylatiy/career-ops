import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('root documentation has only the English README', () => {
  const localized = readdirSync(ROOT).filter((name) => /^README\..+\.md$/.test(name));
  assert.deepEqual(localized, []);
  assert.equal(existsSync(path.join(ROOT, 'README.md')), true);
});

test('locale mode directories do not carry translated README copies', () => {
  const modes = path.join(ROOT, 'modes');
  const localeDirs = ['ar','da','de','es','fr','hi','id','it','ja','ko','nl','pl','pt','ru','tr','ua','zh','zh-TW'];
  const found = [];
  for (const locale of localeDirs) {
    const rootReadme = path.join(modes, locale, 'README.md');
    const interviewReadme = path.join(modes, locale, 'interview', 'README.md');
    if (existsSync(rootReadme)) found.push(path.relative(ROOT, rootReadme));
    if (existsSync(interviewReadme)) found.push(path.relative(ROOT, interviewReadme));
  }
  assert.deepEqual(found, []);
});
