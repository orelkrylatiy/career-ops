import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendTitleTier, queueRoleFamily, queueClaimRank } from '../autopilot-role-triage.mjs';
import { buildQueueSelection } from '../autopilot.mjs';

const titleFilter = { positive: ['react'], negative: ['backend', 'sales'] };
const profile = {
  narrative: { headline: 'React Frontend Engineer' },
  autopilot: {},
};

test('broad frontend triage keeps web and interface roles without a React title', () => {
  for (const title of [
    'Frontend Developer', 'Front-end Engineer', 'Angular Developer',
    'Vue.js Developer', 'Fullstack Golang + React', 'UI Engineer',
    'Software Engineer (Interfaces)', 'Product Web Developer',
    'Фронтенд-разработчик', 'Веб-разработчик', 'Разработчик интерфейсов',
  ]) {
    assert.equal(frontendTitleTier(title), 3, title);
  }
  for (const title of [
    'Product Engineer', 'Software Engineer', 'Staff Software Engineer',
    'Senior AI Developer Experience Engineer',
  ]) {
    assert.equal(frontendTitleTier(title), 2, title);
  }
  assert.equal(frontendTitleTier('Engineer'), 1);
  assert.equal(frontendTitleTier('Разработчик'), 1);
});

test('unrelated functions and pure mobile stacks are not treated as browser frontend', () => {
  for (const title of [
    'Sales Operations Manager', 'Warehouse Supervisor', 'Account Manager',
    'ML Engineer', 'Backend Engineer', 'Data Scientist', 'QA Engineer',
    'React Native Developer', 'Android Engineer', 'iOS Developer',
    'Engineering Manager, Developer Experience',
  ]) {
    assert.equal(frontendTitleTier(title), 0, title);
  }
  assert.equal(frontendTitleTier('Fullstack Web + React Native'), 3);
});

test('candidate-selected role family, not global technology hardcodes, controls queue triage', () => {
  assert.equal(queueRoleFamily(profile, titleFilter), 'frontend');
  assert.equal(queueRoleFamily({ autopilot: { role_family: 'general' } }, titleFilter), 'general');
  assert.equal(queueRoleFamily({}, { positive: ['machine learning'] }), 'general');
  assert.equal(queueRoleFamily({}, { positive: ['TypeScript', 'Node.js'] }), 'general', 'backend JS/TS does not imply frontend');
  assert.equal(queueRoleFamily({ autopilot: { role_family: 'frontend' } }, {}), 'frontend');
});

test('live queue keeps broad frontend role even when exact upstream React title gate rejects it', () => {
  const selection = buildQueueSelection({
    profile,
    titleFilter,
    tracker: { rawSet: new Set(), keySet: new Set() },
    blacklist: new Map(),
    excluded: [],
  });
  const job = (title, host = 'jobs.example.com') => ({
    title, company: 'Test Co', url: `https://${host}/jobs/123`,
    url_key: `https://${host}/jobs/123`,
  });
  assert.equal(selection.family, 'frontend');
  assert.equal(selection.enforceExactTitle, false);
  assert.equal(selection.rejection(job('Software Engineer (Interfaces)')), null);
  assert.equal(selection.rejection(job('Vue.js Engineer')), null);
  assert.equal(selection.rejection(job('Sales Operations Manager')), 'outside_frontend_role_family');
  assert.equal(selection.rejection(job('Frontend Engineer', 'hh.ru')), 'excluded_transport');
  assert.equal(selection.rejection(job('Frontend Engineer', 't.me')), 'excluded_transport');
  assert.equal(selection.rejection(job('React Native Developer')), 'outside_frontend_role_family');

  const strict = buildQueueSelection({
    profile: { autopilot: { role_family: 'frontend', require_title_match_for_apply: true } },
    titleFilter,
    tracker: { rawSet: new Set(), keySet: new Set() },
    blacklist: new Map(),
    excluded: [],
  });
  assert.equal(strict.rejection(job('Software Engineer (Interfaces)')), 'explicit_title_gate');
  assert.equal(strict.rejection(job('React Engineer')), null);
});

test('queued role family dominates stale historical priority but keeps soft priority within a tier', () => {
  const frontend = queueClaimRank({ title: 'Frontend Engineer' }, { family: 'frontend', scoringPriority: 10 });
  const ambiguous = queueClaimRank({ title: 'Software Engineer' }, { family: 'frontend', scoringPriority: 100 });
  const irrelevant = queueClaimRank({ title: 'Account Manager' }, { family: 'frontend', scoringPriority: 100 });
  assert.ok(frontend > ambiguous);
  assert.ok(ambiguous > irrelevant);
});
