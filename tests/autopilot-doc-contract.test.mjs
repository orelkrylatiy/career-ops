import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const research = readFileSync('docs/WEB_AUTOPILOT_RESEARCH.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const agents = readFileSync('AGENTS.md', 'utf8');
const modesReadme = readFileSync('modes/README.md', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const skill = readFileSync('.agents/skills/career-ops/SKILL.md', 'utf8');

test('autonomous research describes the implemented browser-only v1', () => {
  assert.match(research, /Production submission is singular:[\s\S]*Playwright CLI[\s\S]*deterministic submit evidence/);
  assert.match(research, /There is no `ats_api` reporting bypass in v1/);
  assert.doesNotMatch(research, /The current autopilot\.mjs still has a real positive\/negative title gate/);
  assert.doesNotMatch(research, /Playwright MCP\s*\n\s*persistent Chrome/);
});

test('fork quick start states the autonomous Node requirement', () => {
  assert.match(readme, /Autonomous mode requires Node\.js 20\+/);
});

test('fork agent contract is autonomous-browser-first and excludes HH', () => {
  assert.match(agents, /AUTONOMOUS BY DEFAULT/);
  assert.match(agents, /HeadHunter, hh-ops/);
  assert.match(agents, /npm run autopilot/);
  assert.match(modesReadme, /`autopilot\.md` \| `autopilot`/);
});

test('autonomous runtime requires Node 20 or newer', () => {
  assert.equal(packageJson.engines.node, '>=20');
});

test('shared skill router exposes autopilot without nested coding agents', () => {
  assert.match(skill, /\| `autopilot` \| `autopilot` \|/);
  assert.match(skill, /\/career-ops autopilot/);
  assert.match(skill, /Applies to:[^\n]*`autopilot`/);
  assert.match(skill, /No nested coding agents/);
  assert.match(skill, /HeadHunter is out of scope/);
});
