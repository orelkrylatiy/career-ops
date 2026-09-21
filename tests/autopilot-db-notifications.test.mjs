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
  const pending = dbm.listPendingNotifications('telegram', 10);
  assert.equal(pending.length, 1);
  assert.equal(JSON.parse(pending[0].payload_json).metadata.profileKey, 'frontend');

  assert.equal(dbm.markNotificationSent(pending[0].id), true);
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
  assert.equal(dbm.markNotificationFailed(id, 'HTTP 429', retryAt), true);

  const db = dbm.openDb();
  const row = db.prepare('SELECT * FROM notification_outbox WHERE id = ?').get(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'HTTP 429');
  assert.equal(row.next_attempt_at, retryAt);
});
