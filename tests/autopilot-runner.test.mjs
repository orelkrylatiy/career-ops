import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerArgs, resolveAgent, resolveReadyAgent, agentCommand, assertBrowserReady, safeJobId, runOwnerFor, workerPrompt, workerEnvironment, detectBlockingChallenge } from '../autopilot-runner.mjs';

test('runner defaults to real autonomous mode and accepts bounded options', () => {
  assert.equal(parseRunnerArgs([]).dryRun, false);
  assert.equal(parseRunnerArgs([]).maxJobs, 5);
  assert.equal(parseRunnerArgs([]).noScan, true);
  assert.equal(parseRunnerArgs(['--scan']).noScan, false);
  assert.equal(parseRunnerArgs(['--agent','codex','--max-jobs','3','--timeout-minutes','12']).maxJobs, 3);
  assert.throws(() => parseRunnerArgs(['--no-scan', '--refresh-registry']), /conflicts/);
  assert.throws(() => parseRunnerArgs(['--max-jobs','0']), /positive/);
  assert.throws(() => parseRunnerArgs(['--no-scan', '--scan']), /conflicts/);
  assert.throws(() => parseRunnerArgs(['--scan', '--no-scan']), /conflicts/);
  assert.equal(parseRunnerArgs(['--target-applied','30','--max-jobs','120']).targetApplied, 30);
  assert.throws(() => parseRunnerArgs(['--target-applied','0']), /positive/);
  assert.throws(() => parseRunnerArgs(['--agent','fake']), /unsupported/);
});
test('agent detection and invocation are deterministic, without shell interpolation', () => {
  assert.equal(resolveAgent('auto', name => name === 'opencode'), 'opencode');
  assert.throws(() => resolveAgent('auto', () => false), /No coding-agent/);
  const [command, args] = agentCommand('opencode', 'a quote " and ; shell');
  assert.equal(command, 'opencode');
  assert.equal(args.at(-1), 'a quote " and ; shell');
});
test('auto mode falls back from an installed but unauthorized CLI', async () => {
  const attempted = [];
  const selected = await resolveReadyAgent('auto', {
    exists: () => true,
    probe: async name => {
      attempted.push(name);
      return {ok: name === 'codex', output: name === 'codex' ? 'READY\n' : 'not authenticated'};
    },
  });
  assert.equal(selected, 'codex');
  assert.deepEqual(attempted, ['claude', 'codex']);
  await assert.rejects(
    resolveReadyAgent('claude', {exists: () => true, probe: async () => ({ok:false,output:''})}),
    /No authenticated/,
  );
});

test('each campaign uses a fresh claim owner although the browser profile is persistent', () => {
  assert.notEqual(runOwnerFor('aaaaaaaa-1111', 'candidate-direction'), runOwnerFor('bbbbbbbb-2222', 'candidate-direction'));
  assert.match(runOwnerFor('aaaaaaaa-1111', 'candidate-direction'), /^candidate-direction-/);
  assert.throws(() => runOwnerFor('!', 'worker'), /invalid runId/);
});

test('Codex skill router explicitly discovers fork Autopilot and no conflicting npm scan arguments', async () => {
  const { readFileSync } = await import('node:fs');
  const skill = readFileSync(new URL('../.agents/skills/career-ops/SKILL.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(skill, /\| `autopilot` \| `autopilot`/);
  assert.match(skill, /Autonomous submission routing/);
  assert.match(skill, /подай 30 откликов/);
  assert.match(skill, /review-first/);
  assert.equal(pkg.scripts['autopilot:live'], 'node autopilot-runner.mjs');
  assert.equal(pkg.scripts['autopilot:full-scan'], 'node autopilot-scan.mjs --ats-full');
});

test('Codex global approval option precedes exec (CLI parsing regression)', () => {
  const [binary, args] = agentCommand('codex', 'apply to an example job');
  assert.equal(binary, 'codex');
  assert.deepEqual(args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.ok(args.indexOf('--sandbox') > args.indexOf('exec'));
  assert.ok(args.includes('workspace-write'));
  assert.ok(!args.includes('danger-full-access'));
  const dirAt = args.indexOf('--add-dir');
  assert.ok(dirAt >= 0 && args[dirAt + 1], 'selected profile dir must be writable');
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'), 'portal access must be explicit');
  assert.equal(args.at(-1), 'apply to an example job');
});

test('worker instruction requires evidence and never uses HH Ops', () => {
  const job = { url_key: 'https://example.com/1', url: 'https://example.com/1', title: 'Engineer', company: 'Acme' };
  const instruction = workerPrompt(job, 'worker-0');
  assert.match(instruction, /autopilot-verify.mjs begin/);
  assert.match(instruction, /project-local entrypoint/);
  assert.match(instruction, /humanizer-bridge.py/);
  assert.match(instruction, /autopilot-mail.mjs/);
  assert.match(instruction, /No HeadHunter or Telegram/);
  assert.match(instruction, /Never read, run or modify tg-ops, hh-ops/);
  assert.equal(safeJobId(job).length, 16);
});

test('worker instructions avoid duplicate upstream policy loading and retain the per-job boundary', () => {
  const job = { url_key: 'https://example.com/1', url: 'https://example.com/1', title: 'React Engineer', company: 'Acme' };
  const instruction = workerPrompt(job, 'worker-0');
  assert.match(instruction, /do not redundantly read/i);
  assert.match(instruction, /modes\/autopilot\.md/);
  assert.match(instruction, /ONE already-leased job/);
  assert.match(instruction, /currently selected candidate profile/);
  assert.doesNotMatch(instruction, /React\/Next\.js\/Vue match/);
});

test('fork docs never override mandatory eligibility or hardcode an outdated campaign quota', async () => {
  const { readFileSync } = await import('node:fs');
  const policy = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const mode = readFileSync(new URL('../modes/autopilot.md', import.meta.url), 'utf8');
  const overlay = policy.split('## Origin')[0];
  assert.doesNotMatch(overlay, /at least 10 for the Russian market/i);
  assert.match(overlay, /Activation is per run/);
  assert.doesNotMatch(mode, /mismatch with a job requirement is not a reason to skip/i);
  assert.match(mode, /generic queue-state semantics, not personal filters/i);
  assert.match(mode, /config\/profile\.yml/);
  assert.doesNotMatch(overlay, /30 new React applications|permanent 30-job goal/i);
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
  assert.ok(info.profile.endsWith('/data/browser-profile'));

  assert.throws(() => assertBrowserReady({ headless: true, run: () => ({status: 1}) }), /browser startup\/snapshot failed/);
});

test('Linux agent execution uses direct argv without a shell', () => {
  const prompt = 'Cyrillic: вакансии; & echo ATTACK "$(touch /tmp/x)"';
  const [binary, args] = agentCommand('claude', prompt);
  assert.equal(binary, 'claude');
  assert.deepEqual(args, ['-p', prompt, '--permission-mode', 'dontAsk']);
});

test('agent and verifier share exact Playwright CLI named session', () => {
  const env = workerEnvironment('worker-1','run-1','career-ops-worker-0');
  assert.equal(env.PLAYWRIGHT_CLI_SESSION, 'career-ops-worker-0');
  assert.equal(env.AUTOPILOT_BROWSER_SESSION, env.PLAYWRIGHT_CLI_SESSION);
  assert.equal(env.AUTOPILOT_WORKER_ID, 'worker-1');
  assert.ok(env.AUTOPILOT_BROWSER_PROFILE.endsWith('/data/browser-profile'));
  assert.match(env.PLAYWRIGHT_CLI_ENTRYPOINT, /playwright.*cli\.js$/);
  assert.ok(env.PATH.includes('node_modules/.bin'));
  assert.throws(() => workerEnvironment('worker-1','run-1','../../other'), /invalid browser session/);
});

test('a pending CAPTCHA is a job-specific blocker, not a global stop', () => {
  const run = (_bin, _args) => ({status: 0, stdout: JSON.stringify({kind: 'text_image'})});
  assert.equal(detectBlockingChallenge({session:'career-ops-worker-0', run}), 'text_image');
  const thirdParty = () => ({status: 0, stdout: JSON.stringify({kind: 'third_party'})});
  assert.equal(detectBlockingChallenge({run:thirdParty}), 'third_party');
  const missing = () => ({status: 0, stdout: JSON.stringify({kind: 'none'})});
  assert.equal(detectBlockingChallenge({run:missing}), null);
  assert.equal(detectBlockingChallenge({run: () => ({status: 1})}), null);
});

test('unattended browser defaults to headless Chromium without a display', () => {
  const prevHeaded = process.env.AUTOPILOT_BROWSER_HEADED;
  const prevHeadless = process.env.AUTOPILOT_BROWSER_HEADLESS;
  try {
    delete process.env.AUTOPILOT_BROWSER_HEADED;
    delete process.env.AUTOPILOT_BROWSER_HEADLESS;
    const calls = [];
    const run = (_bin, args) => { calls.push(args); return { status: 0 }; };
    const result = assertBrowserReady({ run });
    assert.equal(result.headless, true);
    assert.ok(!calls.flat().includes('--headed'));
    process.env.AUTOPILOT_BROWSER_HEADED = '1';
    calls.length = 0;
    const withWindow = assertBrowserReady({ run });
    assert.equal(withWindow.headless, false);
    assert.ok(calls.flat().includes('--headed'));
  } finally {
    if (prevHeaded == null) delete process.env.AUTOPILOT_BROWSER_HEADED;
    else process.env.AUTOPILOT_BROWSER_HEADED = prevHeaded;
    if (prevHeadless == null) delete process.env.AUTOPILOT_BROWSER_HEADLESS;
    else process.env.AUTOPILOT_BROWSER_HEADLESS = prevHeadless;
  }
});
