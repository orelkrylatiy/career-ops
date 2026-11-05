import test from 'node:test';
import assert from 'node:assert/strict';

test('gmail API module exposes the local transport surface', async () => {
  const mod = await import('../gmail-api.mjs');
  assert.equal(typeof mod.profileEmail, 'function');
  assert.equal(typeof mod.search, 'function');
  assert.equal(typeof mod.readMessage, 'function');
  assert.equal(typeof mod.send, 'function');
});
