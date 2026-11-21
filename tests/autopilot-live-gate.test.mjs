import test from 'node:test';
import assert from 'node:assert/strict';
import { cmdNext, cmdReport } from '../autopilot.mjs';

test('paused campaign prevents claiming or recording browser applications even without runner', async () => {
  const prev = process.env.AUTOPILOT_LIVE;
  delete process.env.AUTOPILOT_LIVE;
  try {
    assert.throws(() => cmdNext({ owner: 'test-worker' }), /campaign paused/);
    await assert.rejects(cmdReport('https://jobs.example.net/1', 'applied'), /campaign paused/);
  } finally {
    if (prev === undefined) delete process.env.AUTOPILOT_LIVE;
    else process.env.AUTOPILOT_LIVE = prev;
  }
});
