import test from 'node:test';
import assert from 'node:assert/strict';
import { publicDiagnostic } from '../autopilot-diagnostics.mjs';
import { scrubLogString, sanitizeLogPayload } from '../autopilot-log.mjs';

test('public diagnostic intentionally excludes every secret and job URL', () => {
 const safe=publicDiagnostic({
    started_at:'2026-10-27T12:00:00.000Z',duration_ms:12,agent:'claude',ok:false,
    counts:{applied:2,claimed:3, secret:'OTP 987654',url:'https://example.com/token=abc'},
    queue:{queued:2,secret:99},error:'password=leaked',token:'abc',run_id:'secret',
    error_code:'RUNNER_FAILED'
 });
 const s=JSON.stringify(safe);
 assert.equal(safe.counts.applied,2);
 for (const secret of ['OTP','987654','https://','token','password','run_id','secret']) assert.ok(!s.includes(secret),secret);
});
test('arbitrary audit strings redact URLs, email, bearer credentials', () => {
 const txt=scrubLogString('visit https://example.com/?code=secret; notify me@company.com Bearer abc-123');
 assert.ok(!txt.includes('secret'));
 assert.ok(!txt.includes('me@'));
 assert.ok(!txt.includes('abc-123'));
 assert.equal(sanitizeLogPayload({email:'foo@bar.com'}).email,'[redacted]');
});
