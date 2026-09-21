import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previous = process.env.CAREER_OPS_AUTOPILOT_DB;
const root = mkdtempSync(join(tmpdir(), 'career-ops-autopilot-db-'));
process.env.CAREER_OPS_AUTOPILOT_DB = join(root, 'autopilot.db');
const dbmod = await import(`../autopilot-db.mjs?profile-outbox-test=${Date.now()}`);
if (previous == null) delete process.env.CAREER_OPS_AUTOPILOT_DB;
else process.env.CAREER_OPS_AUTOPILOT_DB = previous;

test('application profile analytics and notification outbox are persisted together', () => {
  const url = 'https://jobs.example.test/1';
  const key = dbmod.normalizeUrlKey(url);
  dbmod.upsertJob({
    urlKey: key,
    url,
    company: 'Example',
    title: 'Frontend Engineer',
    source: 'jobs.example.test',
    status: 'queued',
  });
  const claimed = dbmod.claimNextJob('test-worker', 5);
  assert.equal(claimed.url_key, key);

  const ok = dbmod.reportOutcome(
    key,
    'applied',
    null,
    'browser',
    {
      claimOwner: 'test-worker',
      ats: 'greenhouse',
      resumeVariant: 'react',
      profileId: 'frontend',
      durationMs: 1200,
      notification: {
        channel: 'telegram',
        eventType: 'application_result',
        payload: {
          outcome: 'applied',
          company: 'Example',
          title: 'Frontend Engineer',
          profile: 'frontend',
        },
      },
    },
  );
  assert.equal(ok, true);

  const all = dbmod.applicationAnalytics();
  assert.equal(all.total, 1);
  assert.equal(all.applied, 1);
  assert.equal(all.by_profile[0].name, 'frontend');
  assert.equal(all.by_profile[0].applied, 1);
  assert.equal(all.by_source[0].name, 'jobs.example.test');

  const filtered = dbmod.applicationAnalytics({ profile: 'frontend' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.profile_filter, 'frontend');
  assert.equal(dbmod.applicationAnalytics({ profile: 'mobile' }).total, 0);

  const pending = dbmod.pendingNotifications('telegram');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event_type, 'application_result');
  assert.match(pending[0].dedupe_key, /^application:\d+:telegram$/);

  const leased = dbmod.claimNextNotification('telegram', 'tg-worker-a', 5);
  assert.equal(leased.id, pending[0].id);
  assert.equal(leased.status, 'sending');
  assert.equal(dbmod.claimNextNotification('telegram', 'tg-worker-b', 5), null);
  assert.equal(dbmod.pendingNotifications('telegram').length, 0);

  assert.equal(dbmod.markNotificationSent(leased.id, 'tg-worker-a'), true);
  assert.equal(dbmod.notificationCounts().sent, 1);
});

test('failed notification gets exponential retry metadata without changing application', () => {
  const db = dbmod.openDb();
  db.prepare(`
    INSERT INTO notification_outbox
      (channel, event_type, dedupe_key, payload_json, status, attempts, created_at)
    VALUES ('telegram', 'application_result', 'manual-test', '{}', 'pending', 0, ?)
  `).run(new Date().toISOString());
  const row = db.prepare("SELECT id FROM notification_outbox WHERE dedupe_key='manual-test'").get();
  assert.equal(dbmod.markNotificationFailed(row.id, 'HTTP 429'), true);
  const updated = db.prepare('SELECT * FROM notification_outbox WHERE id=?').get(row.id);
  assert.equal(updated.status, 'pending');
  assert.equal(updated.attempts, 1);
  assert.match(updated.last_error, /429/);
  assert.ok(updated.next_attempt_at);
});
