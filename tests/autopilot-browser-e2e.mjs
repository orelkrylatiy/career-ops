#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageEntry = require.resolve('playwright');
const cliPath = path.join(path.dirname(packageEntry), 'cli.js');
const root = mkdtempSync(path.join(tmpdir(), 'career-ops-browser-e2e-'));
mkdirSync(path.join(root, 'data'), { recursive: true });
process.env.CAREER_OPS_ROOT = root;
process.env.AUTOPILOT_BROWSER_SESSION = 'career-ops-e2e';

function runCli(args, { allowFailure = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [cliPath, 'cli', '-s=career-ops-e2e', ...args],
    {
      encoding: 'utf8',
      shell: false,
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `playwright cli failed (${args.join(' ')}): `
      + String(result.stderr || result.stdout || result.error?.message || result.status).slice(0, 2000),
    );
  }
  return result;
}

function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/fixtures/autopilot-form-server.mjs'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`fixture server timeout: ${stderr}`));
    }, 10_000);

    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/PORT=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]) });
    });
    child.on('exit', (code) => {
      if (!/PORT=\d+/.test(stdout)) {
        clearTimeout(timer);
        reject(new Error(`fixture server exited ${code}: ${stderr}`));
      }
    });
  });
}

let fixture;
try {
  fixture = await startFixtureServer();
  const jobUrl = `http://127.0.0.1:${fixture.port}/job`;
  const profile = path.join(root, 'data', 'browser-profile');

  runCli(['open', jobUrl, `--profile=${profile}`]);
  runCli([
    'run-code',
    "async page => { await page.locator('input[name=name]').fill('Browser Smoke Candidate'); }",
  ]);

  const verifier = await import(
    pathToFileURL(path.resolve('autopilot-verify.mjs')).href + '?e2e=' + Date.now()
  );

  const armed = verifier.beginVerification(jobUrl, { session: 'career-ops-e2e' });
  assert.equal(armed.receipt.phase, 'armed');
  assert.equal(armed.receipt.before.requiredMissing.length, 0);

  runCli([
    'run-code',
    "async page => { await page.locator('button[type=submit]').click(); await page.waitForTimeout(250); }",
  ]);

  const requestDump = runCli(['requests']).stdout;
  assert.match(
    requestDump,
    /POST[^\n]*\/api\/application/i,
    'Playwright CLI request log should retain the application POST across commands',
  );

  const finished = verifier.finishVerification(armed.receiptPath);
  assert.equal(finished.receipt.phase, 'verified');
  assert.equal(finished.receipt.verification.outcome, 'applied');
  assert.equal(finished.receipt.verification.signals.strongUiSuccess, true);
  assert.equal(finished.receipt.verification.signals.networkSuccess, true);

  console.log('PASS Playwright CLI -> form submit -> deterministic verifier -> applied');
} finally {
  runCli(['close'], { allowFailure: true });
  if (fixture?.child && !fixture.child.killed) fixture.child.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
}
