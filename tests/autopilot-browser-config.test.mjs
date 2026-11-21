import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertLinux, linuxBrowserSettings, browserCliEnvironment } from '../lib/autopilot-browser.mjs';

test('Linux only, no Windows or macOS fallback', () => {
  assert.throws(() => assertLinux('win32'), /Linux only/);
  assert.throws(() => assertLinux('darwin'), /Linux only/);
  assert.doesNotThrow(() => assertLinux('linux'));
});

test('explicit executable is absolute and executable or fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-browser-'));
  try {
    const bin = join(root, 'custom-chrome');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o700);
    const env = {
      AUTOPILOT_BROWSER_EXECUTABLE_PATH: bin,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/ignored/chrome',
      PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/ignored/other',
    };
    assert.equal(linuxBrowserSettings({ env, dataRoot: root }).executablePath, bin);
    assert.equal(browserCliEnvironment({ env, dataRoot: root }).PLAYWRIGHT_MCP_EXECUTABLE_PATH, bin);
    assert.throws(() => linuxBrowserSettings({ env: { AUTOPILOT_BROWSER_EXECUTABLE_PATH: 'chrome' }, dataRoot: root }), /absolute Linux path/);
    assert.throws(() => linuxBrowserSettings({ env: { AUTOPILOT_BROWSER_EXECUTABLE_PATH: '/not-found/chrome' }, dataRoot: root }), /missing or not executable/);
    chmodSync(bin, 0o600);
    assert.throws(() => linuxBrowserSettings({ env: { AUTOPILOT_BROWSER_EXECUTABLE_PATH: bin }, dataRoot: root }), /missing or not executable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('browser profile is independent of executable and resolved against active data root', () => {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-profile-'));
  try {
    assert.equal(linuxBrowserSettings({ env: {}, dataRoot: root }).profileDir, join(root, 'data/browser-profile'));
    assert.equal(linuxBrowserSettings({ env: { AUTOPILOT_BROWSER_PROFILE: 'sessions/react' }, dataRoot: root }).profileDir, join(root, 'sessions/react'));
    const full = join(root, 'explicit-profile');
    assert.equal(linuxBrowserSettings({ env: { AUTOPILOT_BROWSER_PROFILE: full }, dataRoot: root }).profileDir, full);
    assert.equal(linuxBrowserSettings({ env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/fake/chrome' }, dataRoot: root, checkExecutable: () => {} }).executablePath, '/fake/chrome');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
