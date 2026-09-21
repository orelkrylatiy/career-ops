import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const research = readFileSync('docs/WEB_AUTOPILOT_RESEARCH.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');

test('autonomous research describes the implemented browser-only v1', () => {
  assert.match(research, /Production submission is singular:[\s\S]*Playwright CLI[\s\S]*deterministic submit evidence/);
  assert.match(research, /There is no `ats_api` reporting bypass in v1/);
  assert.doesNotMatch(research, /The current autopilot\.mjs still has a real positive\/negative title gate/);
  assert.doesNotMatch(research, /Playwright MCP\s*\n\s*persistent Chrome/);
});

test('fork quick start states the autonomous Node requirement', () => {
  assert.match(readme, /Autonomous mode requires Node\.js 20\+/);
});
