import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectApplicationUrl } from '../autopilot-url-policy.mjs';

test('public application URLs are allowed', () => {
  assert.equal(inspectApplicationUrl('https://jobs.example.com/apply/123').ok, true);
});

for (const url of [
  'http://localhost:3000/job',
  'http://127.0.0.1/job',
  'http://10.1.2.3/job',
  'http://172.16.9.4/job',
  'http://192.168.1.7/job',
  'http://169.254.169.254/latest/meta-data',
  'http://100.100.100.200/latest/meta-data',
  'http://[::1]/job',
  'http://[fd00::1]/job',
  'http://metadata.google.internal/',
]) {
  test(`private destination is refused: ${url}`, () => {
    assert.equal(inspectApplicationUrl(url).ok, false);
  });
}

test('test-only private URL override is explicit', () => {
  assert.equal(
    inspectApplicationUrl('http://127.0.0.1:3210/job', { allowPrivate: true }).ok,
    true,
  );
});
