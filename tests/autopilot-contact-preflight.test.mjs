import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCandidateEmailConsistency } from '../autopilot.mjs';

test('contact preflight detects conflicting primary CV email without logging address', () => {
  const issues = checkCandidateEmailConsistency(
    'candidate@example.net',
    '# Candidate\ncontact: other@example.org\n\n## Experience\nOther experience',
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /does not match/);
  assert.doesNotMatch(issues[0], /other@example.org|candidate@example.net/);
});

test('contact preflight allows matching CV header address', () => {
  assert.deepEqual(
    checkCandidateEmailConsistency('candidate@example.net', '# Candidate\nEMAIL: CANDIDATE@EXAMPLE.NET\n\n## Experience'),
    [],
  );
});

test('contact preflight does not mistake portfolio references for a candidate email', () => {
  assert.deepEqual(
    checkCandidateEmailConsistency('candidate@example.net', '# Candidate\n\n## Experience\nContact: company@example.org'),
    [],
  );
});
