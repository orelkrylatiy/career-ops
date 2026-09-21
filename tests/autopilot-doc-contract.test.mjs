import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const research = readFileSync('docs/WEB_AUTOPILOT_RESEARCH.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const agents = readFileSync('AGENTS.md', 'utf8');
const modesReadme = readFileSync('modes/README.md', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

test('autonomous research describes the implemented browser-only v1', () => {
  assert.match(research, /Production submission is singular:[\s\S]*Playwright CLI[\s\S]*deterministic submit evidence/);
  assert.match(research, /There is no `ats_api` reporting bypass in v1/);
  assert.doesNotMatch(research, /The current autopilot\.mjs still has a real positive\/negative title gate/);
  assert.doesNotMatch(research, /Playwright MCP\s*\n\s*persistent Chrome/);
});

test('fork quick start states the autonomous Node requirement', () => {
  assert.match(readme, /Autonomous mode requires Node\.js 20\+/);
});

test('root agent contract routes explicit autonomous work to autopilot', () => {
  assert.match(agents, /Explicitly asks for autonomous \/ unattended job applications/);
  assert.match(agents, /This fork has one explicit exception: \*\*`autopilot`\*\*/);
  assert.match(agents, /records `Applied` only when `autopilot-verify\.mjs` confirms/);
  assert.match(modesReadme, /`autopilot\.md` \| `autopilot`/);
});

test('autonomous runtime requires Node 20 or newer', () => {
  assert.equal(packageJson.engines.node, '>=20');
});
