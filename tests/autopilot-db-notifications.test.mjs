import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-autopilot-db-'));
process.env.CAREER_OPS_AUTOPILOT_DB = path.join(root, 'autopilot.db');

const dbm = await import(`../autopilot-db.mjs?test=${Date.now()}`);

test('reportOutcome stores profile analytics and Telegram outbox atomically', () => {
  const urlKey = 'https://jobs.example/role/1';
  dbm.upsertJob({
    urlKey,
    url: urlKey,
    company: 'Acme',
    title: 'Frontend Engineer',
    status: 'queued',
  });

  const updated = dbm.reportOutcome(
    urlKey,
    'applied',
    null,
    'browser',
    {
      ats: 'greenhouse',
      resumeVariant: 'react',
      profileKey: 'frontend',
      durationMs: 1234,
      notification: {
        channel: 'telegram',
        eventType: 'application_result',
        payload: {
          outcome: 'applied',
          metadata: { profileKey: 'frontend' },
          job: { company: 'Acme', title: 'Frontend Engineer', url: urlKey },
        },
      },
    },
  );

  assert.equal(updated, true);
  const stats = dbm.applicationAnalytics('frontend');
  assert.equal(stats.total, 1);
  assert.equal(stats.applied, 1);
  assert.equal(stats.by_resume[0].name, 'react');

  const all = dbm.applicationAnalytics();
  const frontend = all.by_profile.find((row) => row.name === 'frontend');
  assert.equal(frontend.total, 1);
  assert.equal(frontend.applied, 1);

  assert.equal(dbm.pendingNotificationCount('telegram'), 1);
  const claimed = dbm.claimPendingNotifications('telegram', 'sender-a', 10, 5);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'sending');
  assert.equal(claimed[0].claim_owner, 'sender-a');
  assert.equal(JSON.parse(claimed[0].payload_json).metadata.profileKey, 'frontend');

  // Another sender cannot see the live lease, which prevents duplicate sends.
  assert.equal(dbm.claimPendingNotifications('telegram', 'sender-b', 10, 5).length, 0);
  assert.equal(dbm.pendingNotificationCount('telegram'), 1);

  assert.equal(dbm.markNotificationSent(claimed[0].id, 'sender-a'), true);
  assert.equal(dbm.pendingNotificationCount('telegram'), 0);
});

test('failed notification stays pending and gets retry metadata', () => {
  const id = dbm.enqueueNotification({
    channel: 'telegram',
    eventType: 'application_result',
    jobUrlKey: 'https://jobs.example/role/2',
    payload: { outcome: 'captcha' },
  });
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const [claimed] = dbm.claimPendingNotifications('telegram', 'sender-retry', 10, 5);
  assert.equal(claimed.id, id);
  assert.equal(dbm.markNotificationFailed(id, 'HTTP 429', retryAt, 'sender-retry'), true);

  const db = dbm.openDb();
  const row = db.prepare('SELECT * FROM notification_outbox WHERE id = ?').get(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'HTTP 429');
  assert.equal(row.next_attempt_at, retryAt);
});

test('expired notification delivery lease is reclaimed after a sender crash', () => {
  const id = dbm.enqueueNotification({
    channel: 'telegram',
    eventType: 'application_result',
    jobUrlKey: 'https://jobs.example/role/3',
    payload: { outcome: 'applied' },
  });
  const [first] = dbm.claimPendingNotifications('telegram', 'dead-sender', 10, 5);
  assert.equal(first.id, id);

  dbm.openDb().prepare(
    "UPDATE notification_outbox SET claim_until='2000-01-01T00:00:00.000Z' WHERE id=?",
  ).run(id);

  const reclaimed = dbm.claimPendingNotifications('telegram', 'replacement-sender', 10, 5);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, id);
  assert.equal(reclaimed[0].claim_owner, 'replacement-sender');
});

