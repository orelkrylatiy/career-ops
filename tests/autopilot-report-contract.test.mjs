import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_CHANNELS } from '../autopilot.mjs';

test('autonomous application reporting has no unverified ATS-API bypass', () => {
  assert.deepEqual(APPLICATION_CHANNELS, ['browser']);
  assert.equal(APPLICATION_CHANNELS.includes('ats_api'), false);
});
