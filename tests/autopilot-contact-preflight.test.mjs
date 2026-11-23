import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCandidateEmailConsistency } from '../autopilot.mjs';

test('contact preflight warns on conflicting primary CV email without logging address', () => {
  const issues = checkCandidateEmailConsistency(
    'candidate@example.net',
    '# Candidate\ncontact: other@example.org\n\n## Experience\nOther experience',
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^warning: candidate\.email differs from primary cv\.md/);
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

test('multiple competing contact emails warn instead of silently passing', () => {
  const issues = checkCandidateEmailConsistency(
    'candidate@example.net',
    '# Candidate\nContact: candidate@example.net; old@example.org\n\n## Experience',
  );
  assert.equal(issues.length, 1);
  assert.doesNotMatch(issues[0], /candidate@example.net|old@example.org/);
});

test('PDF contact mismatches identify source without exposing private email', () => {
  const issues = checkCandidateEmailConsistency(
    'candidate@example.net',
    'Candidate\nEmail: incorrect@example.org',
    'prepared resume PDF',
  );
  assert.match(issues[0], /^warning: .*prepared resume PDF/);
  assert.doesNotMatch(issues[0], /incorrect@example.org/);
});

test('strict email-match option explicitly blocks a mismatch without exposing either address', () => {
  const issues = checkCandidateEmailConsistency(
    'candidate@example.net',
    'Candidate\nEmail: incorrect@example.org',
    'prepared resume PDF',
    { strict: true },
  );
  assert.equal(issues.length, 1);
  assert.doesNotMatch(issues[0], /^warning:/);
  assert.match(issues[0], /prepared resume PDF/);
  assert.doesNotMatch(issues[0], /incorrect@example.org|candidate@example.net/);
});
