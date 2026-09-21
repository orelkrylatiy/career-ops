import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scan = readFileSync('scan.mjs', 'utf8');
const full = readFileSync('scan-ats-full.mjs', 'utf8');
const autopilot = readFileSync('autopilot.mjs', 'utf8');

test('wide configured scan removes provider-side location hints', () => {
  assert.match(scan, /locationHints:\s*wide \? null : config\.location_filter/);
});

test('wide configured scan excludes Telegram transport', () => {
  assert.match(scan, /wide && resolved\.provider\?\.id === 'telegram-channel'/);
});

test('reverse ATS scanner exposes a wide mode and disables fit filters', () => {
  assert.match(full, /'--wide'/);
  assert.match(full, /const titleFilter = opts\.wide\s*\? pass/);
  assert.match(full, /const locationFilter = opts\.wide \? pass/);
  assert.match(full, /const contentFilter = opts\.wide \? pass/);
  assert.match(full, /locationHints: opts\.wide \? null/);
});

test('autopilot deep scan composes configured, regional and ATS-directory discovery', () => {
  assert.match(autopilot, /configured.*SCAN_PATH/s);
  assert.match(autopilot, /registry-\$\{registryCommand\}/);
  assert.match(autopilot, /'regional'/);
  assert.match(autopilot, /'ats-full'/);
  assert.match(autopilot, /greenhouse,lever,ashby,workday,icims/);
  assert.match(autopilot, /'yc,a16z'/);
});
