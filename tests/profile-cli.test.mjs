// tests/profile-cli.test.mjs — profile.mjs end-to-end against a temp data
// root: registry CRUD, the direction skeleton, env/launch output and stats.
// CAREER_OPS_PROFILES + CAREER_OPS_ROOT keep the run off the real registry.
//
// Run:  node --test tests/profile-cli.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

function runCli(args, env) {
  return spawnSync(NODE, [join(ROOT, 'profile.mjs'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function freshRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'profile-cli-'));
  return { dir, env: { CAREER_OPS_ROOT: dir, CAREER_OPS_PROFILES: join(dir, 'profiles.yml') } };
}

test('add-profile creates local candidate without Telegram', () => {
  const { dir, env } = freshRoot();
  try {
    const res = runCli(['add-profile', 'maxim', '--name', 'Maxim', '--json'], env);
    assert.equal(res.status, 0, res.stderr);
    const reg = yaml.load(readFileSync(join(dir, 'profiles.yml'), 'utf-8'));
    assert.equal(reg.profiles[0].id, 'maxim');
    assert.deepEqual(reg.profiles[0].telegram, []);

    assert.notEqual(runCli(['add-profile', 'maxim', '--name', 'X'], env).status, 0); // dup
    assert.notEqual(runCli(['add-profile', 'Bad Slug', '--name', 'X'], env).status, 0); // bad id
    assert.equal(runCli(['add-profile', 'ok2', '--name', 'X'], env).status, 0); // no Telegram required
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add-direction creates the isolated data-root skeleton and registers it', () => {
  const { dir, env } = freshRoot();
  try {
    assert.equal(runCli(['add-profile', 'maxim', '--name', 'Maxim'], env).status, 0);
    const res = runCli(['add-direction', 'maxim', 'analyst', '--name', 'Data Analyst', '--json'], env);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    const root = join(dir, 'data', 'profiles', 'maxim', 'analyst');
    assert.equal(payload.root, root);
    for (const f of ['data/applications.md', 'config/profile.yml', 'portals.yml', 'cv.md', 'modes/_profile.md']) {
      assert.ok(existsSync(join(root, f)), `${f} missing`);
    }
    const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf-8');
    assert.match(tracker, /\| # \| Date \| Company \| Role \| Score \| Status \| PDF \| Report \| Notes \|/);

    const reg = yaml.load(readFileSync(join(dir, 'profiles.yml'), 'utf-8'));
    assert.equal(reg.profiles[0].directions[0].id, 'analyst');

    assert.notEqual(runCli(['add-direction', 'maxim', 'analyst', '--name', 'Dup'], env).status, 0);
    assert.notEqual(runCli(['add-direction', 'ghost', 'x', '--name', 'X'], env).status, 0); // no profile
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env and launch print the isolation recipe: root, worker, session, browser profile', () => {
  const { dir, env } = freshRoot();
  try {
    runCli(['add-profile', 'maxim', '--name', 'Maxim'], env);
    runCli(['add-direction', 'maxim', 'analyst', '--name', 'Data Analyst'], env);

    const bash = runCli(['env', 'maxim', 'analyst'], env);
    assert.equal(bash.status, 0, bash.stderr);
    // The root is printed relative to the CODE root (path-resolver resolves
    // relative CAREER_OPS_ROOT values against it) — the temp data root sits
    // elsewhere, so only the tail is stable here.
    assert.match(bash.stdout, /export CAREER_OPS_ROOT='.*data\/profiles\/maxim\/analyst'/);
    assert.match(bash.stdout, /export AUTOPILOT_WORKER_ID='maxim-analyst'/);
    assert.match(bash.stdout, /export AUTOPILOT_BROWSER_SESSION='career-ops-maxim-analyst'/);
    assert.match(bash.stdout, /export PLAYWRIGHT_CLI_SESSION='career-ops-maxim-analyst'/);
    assert.match(bash.stdout, /export AUTOPILOT_BROWSER_PROFILE='.*data\/profiles\/maxim\/analyst\/data\/browser-profile'/);
    assert.notEqual(runCli(['env', 'maxim', 'analyst', '--shell', 'powershell'], env).status, 0);

    const launch = runCli(['launch', 'maxim', 'analyst'], env);
    assert.equal(launch.status, 0, launch.stderr);
    assert.match(launch.stdout, /npx playwright cli -s=career-ops-maxim-analyst /);
    assert.match(launch.stdout, /--profile='.*data\/profiles\/maxim\/analyst\/data\/browser-profile'/);

    const fakeBrowser = join(dir, 'fake-chrome');
    writeFileSync(fakeBrowser, '#!/bin/sh\\nexit 0\\n');
    chmodSync(fakeBrowser, 0o700);
    const selectedEnv = { ...env,
      AUTOPILOT_BROWSER_EXECUTABLE_PATH: fakeBrowser,
      AUTOPILOT_BROWSER_PROFILE: 'browser-state' };
    const selected = runCli(['env', 'maxim', 'analyst', '--json'], selectedEnv);
    assert.equal(selected.status, 0, selected.stderr);
    const values = JSON.parse(selected.stdout).env;
    assert.equal(values.PLAYWRIGHT_MCP_EXECUTABLE_PATH, fakeBrowser);
    assert.equal(values.AUTOPILOT_BROWSER_PROFILE, join(dir, 'data', 'profiles', 'maxim', 'analyst', 'browser-state'));
    assert.equal(values.CAREER_OPS_PROFILE_BASE_ROOT, dir);
    assert.equal(values.CAREER_OPS_PROFILES, join(dir, 'profiles.yml'));

    // Applying the exports must not move the registry or nest data/profiles twice.
    const secondLaunch = runCli(['launch', 'maxim', 'analyst', '--json'], { ...selectedEnv, ...values });
    assert.equal(secondLaunch.status, 0, secondLaunch.stderr);
    const roundTrip = JSON.parse(secondLaunch.stdout);
    assert.ok(roundTrip.command.includes(join(dir, 'data', 'profiles', 'maxim', 'analyst', 'browser-state')));
    assert.ok(!roundTrip.command.includes('analyst/data/profiles/maxim/analyst'));
    const customLaunch = runCli(['launch', 'maxim', 'analyst'], selectedEnv);
    assert.equal(customLaunch.status, 0, customLaunch.stderr);
    assert.ok(customLaunch.stdout.includes(fakeBrowser));
    assert.match(customLaunch.stdout, /PLAYWRIGHT_MCP_EXECUTABLE_PATH=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stats reads a direction tracker under its own data root', () => {
  const { dir, env } = freshRoot();
  try {
    runCli(['add-profile', 'maxim', '--name', 'Maxim'], env);
    runCli(['add-direction', 'maxim', 'analyst', '--name', 'Data Analyst'], env);
    const tracker = join(dir, 'data', 'profiles', 'maxim', 'analyst', 'data', 'applications.md');
    writeFileSync(tracker, readFileSync(tracker, 'utf-8')
      + '| 1 | 2026-09-20 | Acme | Data Engineer | 4.0/5 | Applied | ❌ | — | note |\n'
      + '| 2 | 2026-09-21 | Globex | Analyst | 3.5/5 | Interview | ❌ | — | note |\n');

    const res = runCli(['stats', 'maxim', 'analyst', '--json'], env);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.stats.tracker.total, 2);
    assert.equal(payload.stats.funnel.everApplied, 2);
    assert.equal(payload.stats.funnel.everInterview, 1);

    const all = runCli(['stats', 'maxim', '--json'], env);
    assert.equal(JSON.parse(all.stdout).profiles[0].aggregate.funnel.everApplied, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remove-direction keeps data by default, deletes it with --purge', () => {
  const { dir, env } = freshRoot();
  try {
    runCli(['add-profile', 'maxim', '--name', 'Maxim'], env);
    runCli(['add-direction', 'maxim', 'analyst', '--name', 'Data Analyst'], env);
    runCli(['add-direction', 'maxim', 'react', '--name', 'React Dev'], env);
    const analystRoot = join(dir, 'data', 'profiles', 'maxim', 'analyst');
    const reactRoot = join(dir, 'data', 'profiles', 'maxim', 'react');

    runCli(['remove-direction', 'maxim', 'analyst'], env);
    assert.ok(existsSync(analystRoot), 'data root must survive without --purge');
    runCli(['remove-direction', 'maxim', 'react', '--purge'], env);
    assert.ok(!existsSync(reactRoot), '--purge must delete the data root');

    const reg = yaml.load(readFileSync(join(dir, 'profiles.yml'), 'utf-8'));
    assert.equal(reg.profiles[0].directions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('React, Next.js and Vue directions isolate CV, tracker and browser identities', () => {
  const { dir, env } = freshRoot();
  try {
    assert.equal(runCli(['add-profile', 'candidate', '--name', 'Candidate'], env).status, 0);
    const sessions = [];
    for (const name of ['react', 'nextjs', 'vue']) {
      const add = runCli(['add-direction', 'candidate', name, '--name', name], env);
      assert.equal(add.status, 0, add.stderr);
      const root = join(dir, 'data', 'profiles', 'candidate', name);
      for (const path of ['cv.md', 'config/profile.yml', 'portals.yml', 'data/applications.md']) {
        assert.ok(existsSync(join(root, path)), path + ' missing for ' + name);
      }
      const output = runCli(['env', 'candidate', name], env).stdout;
      assert.ok(output.includes('career-ops-candidate-' + name));
      sessions.push(output);
    }
    assert.equal(new Set(sessions).size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list on a missing registry points at the setup command instead of crashing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-cli-2-'));
  try {
    const res = runCli(['list'], { CAREER_OPS_ROOT: dir, CAREER_OPS_PROFILES: join(dir, 'profiles.yml') });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /add-profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
