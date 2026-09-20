import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyApplicationEvidence, evidenceMatchesOutcome } from '../autopilot-verify.mjs';

test('explicit confirmation is a confirmed application', () => {
  const out = classifyApplicationEvidence({
    before: { url: 'https://jobs.example/apply', formCount: 1 },
    after: {
      url: 'https://jobs.example/thank-you',
      bodyText: 'Thank you for applying',
      formCount: 0,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: {
      requests: [{
        method: 'POST',
        url: 'https://jobs.example/api/applications',
        status: 201,
        requestLooksLikeApplication: true,
        responseLooksSuccess: true,
        responseLooksError: false,
      }],
    },
  });
  assert.equal(out.outcome, 'applied');
  assert.equal(out.confidence, 'high');
});

test('successful submit-like request without confirmation is unconfirmed', () => {
  const out = classifyApplicationEvidence({
    before: { url: 'https://jobs.example/apply', formCount: 1 },
    after: {
      url: 'https://jobs.example/apply',
      bodyText: 'Application form',
      formCount: 1,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: {
      requests: [{
        method: 'POST',
        url: 'https://jobs.example/graphql',
        status: 200,
        requestLooksLikeApplication: true,
        responseLooksSuccess: false,
        responseLooksError: false,
      }],
    },
  });
  assert.equal(out.outcome, 'submitted_unconfirmed');
});

test('visible field errors beat ambiguous network activity', () => {
  const out = classifyApplicationEvidence({
    before: { url: 'https://jobs.example/apply', formCount: 1 },
    after: {
      url: 'https://jobs.example/apply',
      bodyText: 'Please complete the form',
      formCount: 1,
      validationErrors: ['This field is required'],
      nativeInvalidCount: 1,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'validation_failed');
});

test('captcha/challenge becomes blocked', () => {
  const out = classifyApplicationEvidence({
    before: { formCount: 1 },
    after: { bodyText: 'Verify you are human', validationErrors: [], nativeInvalidCount: 0 },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'blocked');
});

test('report evidence must be verified, job-bound and outcome-bound', () => {
  const receipt = {
    phase: 'verified',
    job_url_key: 'https://example.com/job/1',
    verification: { outcome: 'applied' },
  };
  assert.deepEqual(
    evidenceMatchesOutcome(receipt, 'https://example.com/job/1', 'applied'),
    { ok: true },
  );
  assert.equal(evidenceMatchesOutcome(receipt, 'https://example.com/job/2', 'applied').ok, false);
  assert.equal(
    evidenceMatchesOutcome(receipt, 'https://example.com/job/1', 'submitted_unconfirmed').ok,
    false,
  );
});
