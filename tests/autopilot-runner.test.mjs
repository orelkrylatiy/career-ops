import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerArgs, resolveAgent, agentCommand, platformCommand, assertBrowserReady, safeJobId, workerPrompt, workerEnvironment } from '../autopilot-runner.mjs';

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
test('Codex global approval option precedes exec (CLI parsing regression)', () => {
  const [binary, args] = agentCommand('codex', 'apply to an example job');
  assert.equal(binary, 'codex');
  assert.deepEqual(args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.ok(args.indexOf('--sandbox') > args.indexOf('exec'));
  assert.equal(args.at(-1), 'apply to an example job');
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

test('Windows npm CLI shims use encoded argv, never interpolate an untrusted prompt', () => {
  const prompt = 'Cyrillic: вакансии; & echo ATTACK \"$(touch /tmp/x)\"';
  const argv = ['-p', prompt, '--permission-mode', 'bypassPermissions'];
  const [binary, args] = platformCommand('claude', argv, 'win32');
  assert.equal(binary, 'powershell.exe');
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.ok(!script.includes(prompt), 'untrusted prompt must not be shell source');
  const encoded = script.match(/FromBase64String\(\"([^\"]+)\"\)/)?.[1];
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), argv);
  assert.throws(() => platformCommand('not-allowed', [], 'win32'), /unsupported/);
  assert.deepEqual(platformCommand('claude', argv, 'linux'), ['claude', argv]);
});

test('agent and verifier share exact Playwright CLI named session', () => {
  const env = workerEnvironment('worker-1','run-1','career-ops-worker-0');
  assert.equal(env.PLAYWRIGHT_CLI_SESSION, 'career-ops-worker-0');
  assert.equal(env.AUTOPILOT_BROWSER_SESSION, env.PLAYWRIGHT_CLI_SESSION);
  assert.equal(env.AUTOPILOT_WORKER_ID, 'worker-1');
  assert.throws(() => workerEnvironment('worker-1','run-1','../../other'), /invalid browser session/);
});
