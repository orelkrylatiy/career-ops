import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sendTelegram } from '../notify-tg.mjs';

test('legacy Telegram shim performs no send', async () => {
  const out = await sendTelegram('must not leave this process');
  assert.deepEqual(out, { sent: false, reason: 'removed_from_autopilot_core' });
});

for (const file of ['autopilot-browser.mjs', 'extract-contacts.mjs']) {
  test(`${file} is a non-operational tombstone`, () => {
    const res = spawnSync(process.execPath, [file], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /retired/);
  });
}
