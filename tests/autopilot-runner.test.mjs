import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerArgs, resolveAgent, agentCommand, assertBrowserReady, safeJobId, workerPrompt } from '../autopilot-runner.mjs';

test('runner defaults to real autonomous mode and accepts bounded options', () => {
  assert.equal(parseRunnerArgs([]).dryRun, false);
  assert.equal(parseRunnerArgs(['--agent','codex','--max-jobs','3','--timeout-minutes','12']).maxJobs, 3);
  assert.throws(() => parseRunnerArgs(['--no-scan', '--refresh-registry']), /conflicts/);
  assert.throws(() => parseRunnerArgs(['--max-jobs','0']), /positive/);
  assert.throws(() => parseRunnerArgs(['--agent','fake']), /unsupported/);
});
test('agent detection and invocation are deterministic, without shell interpolation', () => {
  assert.equal(resolveAgent('auto', name => name === 'opencode'), 'opencode');
  assert.throws(() => resolveAgent('auto', () => false), /No coding-agent/);
  const [command, args] = agentCommand('opencode', 'a quote " and ; shell');
  assert.equal(command, 'opencode');
  assert.equal(args.at(-1), 'a quote " and ; shell');
});
test('worker instruction requires evidence and never uses HH Ops', () => {
  const job = { url_key: 'https://example.com/1', url: 'https://example.com/1', title: 'Engineer', company: 'Acme' };
  const instruction = workerPrompt(job, 'worker-0');
  assert.match(instruction, /autopilot-verify.mjs begin/);
  assert.match(instruction, /humanizer-bridge.py/);
  assert.match(instruction, /autopilot-mail.mjs/);
  assert.match(instruction, /never HeadHunter/);
  assert.equal(safeJobId(job).length, 16);
});

test('browser must open a real named session and snapshot BEFORE processing jobs', () => {
  const calls = [];
  const mockedRun = (_binary, args) => { calls.push(args); return { status: 0 }; };
  const info = assertBrowserReady({ headless: true, run: mockedRun });
  assert.equal(info.session, 'career-ops-worker-0');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('open'));
  assert.ok(calls[0].includes('about:blank'));
  assert.ok(calls[0].some(s => String(s).startsWith('--profile=')));
  assert.equal(calls[1].at(-1), 'snapshot');
  assert.throws(() => assertBrowserReady({ headless: true, run: () => ({status: 1}) }), /browser startup\/snapshot failed/);
});
