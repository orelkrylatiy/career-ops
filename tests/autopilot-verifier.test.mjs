import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPageProbeCode,
  classifyApplicationEvidence,
  compactPageEvidence,
  evidenceMatchesOutcome,
  parseRequestList,
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

test('Habr one-click response is confirmed when the response control becomes a supplement form', () => {
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://career.habr.com/vacancies/1000169456',
      submitCount: 2,
      successTextSeen: false,
    },
    after: {
      url: 'https://career.habr.com/vacancies/1000169456',
      submitCount: 1,
      successTextSeen: true,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'applied');
  assert.equal(out.confidence, 'medium');
});

test('Habr confirmation already visible before a click is not a new application', () => {
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://career.habr.com/vacancies/1000169456',
      submitCount: 1,
      successTextSeen: true,
    },
    after: {
      url: 'https://career.habr.com/vacancies/1000169456',
      submitCount: 0,
      successTextSeen: true,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'submitted_unconfirmed');
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

test('required react-select typeahead input is judged by its widget value, not its own', () => {
  const source = buildPageProbeCode();
  // The invisible react-select <input class="select__input"> carries aria-required
  // but stays empty by design; the committed value lives in the sibling
  // .select__single-value text or the container's data-value attribute.
  assert.match(source, /select__input/);
  assert.match(source, /select__single-value/);
  assert.match(source, /data-value/);
});

test('native controls gate on required only; aria-required advisory inputs stay exempt', () => {
  const source = buildPageProbeCode();
  // Vercel/Greenhouse mark optional-but-asterisked native inputs (LinkedIn,
  // portfolio link) with aria-required=true while required stays false — the
  // browser's own constraint validation never blocks on them, so the pre-submit
  // gate must not either. react-select typeaheads (role=combobox on a native
  // input) are the exception: judged as widgets via their committed value.
  assert.match(source, /if \(!el\.required\) return false;/);
  assert.match(source, /isSelectWidget/);
  assert.match(source, /role'\] === 'combobox'|role === 'combobox'/);
});

test('ARIA combobox on a native input reads the value property before widget fallback', () => {
  const source = buildPageProbeCode();
  // Angular Material mat-autocomplete triggers (role=combobox + aria-required
  // on a native <input>) keep the selected value in the value PROPERTY — the
  // value attribute stays empty. Without the property read the widget branch
  // judges the field empty and pre-submit validation false-positives.
  assert.match(source, /el\.tagName === 'INPUT' \|\| el\.tagName === 'TEXTAREA'/);
  assert.match(source, /value = String\(el\.value \|\| ''\)/);
});

test('new success copy alone does not confirm an application without a transition', () => {
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://jobs.example/apply',
      successTextSeen: false,
      formCount: 1,
    },
    after: {
      url: 'https://jobs.example/apply',
      successTextSeen: true,
      formCount: 1,
      validationErrorCount: 0,
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'submitted_unconfirmed');
});

test('generic successful GraphQL traffic is not treated as application submission', () => {
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://jobs.example/apply',
      successTextSeen: false,
      formCount: 1,
    },
    after: {
      url: 'https://jobs.example/apply',
      successTextSeen: false,
      formCount: 1,
      validationErrorCount: 0,
      nativeInvalidCount: 0,
    },
    network: {
      requests: [{
        method: 'POST',
        url: 'https://jobs.example/graphql',
        status: 200,
        requestLooksLikeApplication: false,
        responseLooksSuccess: true,
        responseLooksError: false,
      }],
    },
  });
  assert.equal(out.outcome, 'submitted_unconfirmed');
  assert.equal(out.signals.networkSuccess, false);
});

test('Playwright request parser accepts documented and raw-style list lines', () => {
  const rows = parseRequestList([
    '# 1. [GET] https://example.test/api/ping => [200] OK',
    '2. [POST] https://example.test/api/application => [201] Created',
  ].join('\n'));
  assert.deepEqual(rows, [
    {
      index: 1,
      method: 'GET',
      url: 'https://example.test/api/ping',
      status: 200,
      statusText: '200',
    },
    {
      index: 2,
      method: 'POST',
      url: 'https://example.test/api/application',
      status: 201,
      statusText: '201',
    },
  ]);
});

test('ambient pre-submit challenge copy does not mask a success-URL redirect', () => {
  // solid.jobs-style form: invisible reCAPTCHA copy present before Submit,
  // server redirects to /apply-succeeded/<id> after a successful POST.
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://solid.jobs/apply/1/company-role',
      formCount: 1,
      blockedTextSeen: true,
    },
    after: {
      url: 'https://solid.jobs/apply-succeeded/1/company-role',
      bodyText: 'Twoja aplikacja została wysłana',
      formCount: 0,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'applied');
});

test('challenge copy that appears only after submit is still blocked', () => {
  const out = classifyApplicationEvidence({
    before: { url: 'https://jobs.example/apply', formCount: 1 },
    after: {
      url: 'https://jobs.example/apply',
      bodyText: 'Verify you are human',
      formCount: 1,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'blocked');
});

test('GeekJob post-submit state with disappearing submit button is applied', () => {
  // GeekJob keeps the respond <form> and the URL; the submit button is
  // replaced by the "already responded" success copy. That swap is the
  // deterministic transition.
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://geekjob.ru/vacancy/6ad260fdb9a005db540342b7',
      formCount: 1,
      submitCount: 1,
    },
    after: {
      url: 'https://geekjob.ru/vacancy/6ad260fdb9a005db540342b7',
      bodyText: 'Уже откликнулись. Вы успешно отправили запрос на эту вакансию. Повторно отправить запрос можно через 7 дней',
      formCount: 1,
      submitCount: 0,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'applied');
  assert.equal(out.confidence, 'medium');
});

test('submit button disappearing without new success copy stays unconfirmed', () => {
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://geekjob.ru/vacancy/6ad260fdb9a005db540342b7',
      formCount: 1,
      submitCount: 1,
    },
    after: {
      url: 'https://geekjob.ru/vacancy/6ad260fdb9a005db540342b7',
      bodyText: 'form quietly re-rendered',
      formCount: 1,
      submitCount: 0,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.equal(out.outcome, 'submitted_unconfirmed');
});

test('pre-existing GeekJob already-responded copy is not a new confirmation', () => {
  // A second visit to an already-responded vacancy must not classify as a
  // fresh application: the success copy was there before any submit click.
  const out = classifyApplicationEvidence({
    before: {
      url: 'https://geekjob.ru/vacancy/6ad260fdb9a005db540342b7',
      formCount: 1,
      submitCount: 0,
      bodyText: 'Уже откликнулись. Вы успешно отправили запрос на эту вакансию.',
    },
    after: {
      url: 'https://geekjob.ru/vacancy/6ad260fdb9a005db540342b7',
      bodyText: 'Уже откликнулись. Вы успешно отправили запрос на эту вакансию.',
      formCount: 1,
      submitCount: 0,
      validationErrors: [],
      nativeInvalidCount: 0,
    },
    network: { requests: [] },
  });
  assert.notEqual(out.outcome, 'applied');
});
