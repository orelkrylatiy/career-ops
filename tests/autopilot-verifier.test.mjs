import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPageProbeCode,
  classifyApplicationEvidence,
  compactPageEvidence,
  evidenceMatchesOutcome,
} from '../autopilot-verify.mjs';

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
    started_at: '2026-09-21T10:00:00.000Z',
    finished_at: '2026-09-21T10:01:00.000Z',
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
  assert.deepEqual(
    evidenceMatchesOutcome(receipt, 'https://example.com/job/1', 'applied', {
      claimedAt: '2026-09-21T09:59:00.000Z',
    }),
    { ok: true },
  );
});

test('evidence from before the current claim cannot be replayed', () => {
  const receipt = {
    phase: 'verified',
    job_url_key: 'https://example.com/job/1',
    started_at: '2026-09-21T09:58:00.000Z',
    finished_at: '2026-09-21T09:59:00.000Z',
    verification: { outcome: 'applied' },
  };
  assert.deepEqual(
    evidenceMatchesOutcome(receipt, 'https://example.com/job/1', 'applied', {
      claimedAt: '2026-09-21T10:00:00.000Z',
    }),
    { ok: false, reason: 'receipt_predates_claim' },
  );
});


test('a success-shaped URL that was already present before submit is not confirmation', () => {
  const out = classifyApplicationEvidence({
    before: { url: 'https://jobs.example/thank-you', urls: ['https://jobs.example/thank-you'], bodyText: 'Application form', formCount: 1 },
    after: { url: 'https://jobs.example/thank-you', urls: ['https://jobs.example/thank-you'], bodyText: 'Application form', formCount: 1, validationErrors: [], nativeInvalidCount: 0 },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'submitted_unconfirmed');
});

test('pre-existing success copy is not accepted as a new confirmation', () => {
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://jobs.example/apply',
      bodyText: 'Before you apply: thank you for applying responsibly.',
      formCount: 1,
    },
    after: {
      url: 'https://jobs.example/apply',
      bodyText: 'Before you apply: thank you for applying responsibly.',
      formCount: 1,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'submitted_unconfirmed');
});

test('failed submit-like request is classified as failed', () => {
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
        url: 'https://jobs.example/api/application',
        status: 500,
        requestLooksLikeApplication: true,
        responseLooksSuccess: false,
        responseLooksError: true,
      }],
    },
  });
  assert.equal(out.outcome, 'failed');
});

test('generated cross-frame Playwright probe is valid JavaScript', () => {
  const source = buildPageProbeCode(2000);
  const factory = new Function('return (' + source + ')');
  const probe = factory();
  assert.equal(typeof probe, 'function');
});

test('persisted page evidence strips body text and keeps only classification flags', () => {
  const compact = compactPageEvidence({
    url: 'https://jobs.example/apply',
    bodyText: 'candidate@example.net Thank you for applying',
    formCount: 1,
    submitCount: 1,
    validationErrors: [],
    nativeInvalidCount: 0,
  });
  assert.equal(Object.hasOwn(compact, 'bodyText'), false);
  assert.equal(compact.successTextSeen, true);
  assert.equal(JSON.stringify(compact).includes('candidate@example.net'), false);
});

test('compact success flags still classify a confirmed application', () => {
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://jobs.example/apply',
      urls: ['https://jobs.example/apply'],
      successTextSeen: false,
      formCount: 1,
    },
    after: {
      url: 'https://jobs.example/apply',
      urls: ['https://jobs.example/apply'],
      successTextSeen: true,
      validationErrorCount: 0,
      nativeInvalidCount: 0,
      formCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'applied');
});

test('generated probe checks custom ARIA-required widgets and role buttons', () => {
  const source = buildPageProbeCode();
  assert.match(source, /aria-required/);
  assert.match(source, /radiogroup/);
  assert.match(source, /role="button"/);
  assert.match(source, /complete\|finish/);
});
