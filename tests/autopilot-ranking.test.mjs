import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob } from '../autopilot-ranking.mjs';

const profile = {
  location: { country: 'Russia', city: 'Moscow' },
  autopilot: {
    remote_only: true,
    blocked_locations: ['london'],
    priority_sources: ['hh.ru'],
    priority_locations: ['russia'],
  },
};
const titleFilter = {
  positive: ['react', 'frontend'],
  negative: ['sales'],
};

test('matching jobs rank higher but non-matches remain eligible', () => {
  const now = Date.parse('2026-09-21T00:00:00Z');
  const strong = scoreJob({
    title: 'Senior React Frontend Engineer',
    location: 'Remote, Russia',
    url: 'https://hh.ru/vacancy/1',
    posted: '2026-09-20T12:00:00Z',
  }, { profile, titleFilter, nowMs: now });
  const weak = scoreJob({
    title: 'Sales Operations Manager',
    location: 'London hybrid',
    url: 'https://example.com/job/2',
  }, { profile, titleFilter, nowMs: now });

  assert.ok(strong.priority > weak.priority);
  assert.ok(weak.priority >= 0);
  assert.ok(weak.reasons.some((r) => r.startsWith('title_negative:')));
});

test('location preferences are penalties, never rejection decisions', () => {
  const row = scoreJob({
    title: 'Frontend Engineer',
    location: 'London hybrid',
    url: 'https://example.com/job/3',
  }, { profile, titleFilter });
  assert.equal(typeof row.priority, 'number');
  assert.ok(row.reasons.some((r) => r.startsWith('location_deprioritized:')));
  assert.ok(row.reasons.includes('remote_preference_conflict:-12'));
});
