import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLogPayload } from '../autopilot-log.mjs';

test('audit log redacts sensitive keys recursively', () => {
  const out = sanitizeLogPayload({
    email: 'candidate@example.com',
    nested: { phone: '+1 555', token: 'secret', field: 'safe-label' },
    list: [{ answer: 'yes', kind: 'checkbox' }],
  });
  assert.equal(out.email, '[redacted]');
  assert.equal(out.nested.phone, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.field, 'safe-label');
  assert.equal(out.list[0].answer, '[redacted]');
  assert.equal(out.list[0].kind, 'checkbox');
});

test('audit log bounds long untrusted strings', () => {
  const out = sanitizeLogPayload({ message: 'x'.repeat(3000) });
  assert.ok(out.message.length < 1300);
  assert.match(out.message, /…$/);
});
