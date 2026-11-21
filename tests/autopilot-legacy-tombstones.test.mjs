import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('legacy Telegram transport and old browser scripts are not included in the rebuilt fork', () => {
  for (const file of [
    'notify-tg.mjs',
    'tg-bot.mjs',
    'lib/tg-bot-core.mjs',
    'autopilot-browser.mjs',
    'extract-contacts.mjs',
  ]) {
    assert.equal(existsSync(path.join(root, file)), false,
      file + ' must not be available to an autonomous Career Ops worker');
  }
});
