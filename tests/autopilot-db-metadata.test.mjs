import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(path.join(tmpdir(), 'career-ops-db-test-'));
process.env.CAREER_OPS_ROOT = ROOT;

const modUrl = pathToFileURL(path.resolve('autopilot-db.mjs')).href + '?test=' + Date.now();
const {
  openDb,
  upsertJob,
  reportOutcome,
  applicationAnalytics,
  normalizeUrlKey,
  claimNextJob,
  releaseClaim,
  renewClaim,
} = await import(modUrl);

test('application journal records ATS, resume and duration metadata', () => {
  const url = 'https://jobs.example.com/role/123?utm_source=test';
  const key = normalizeUrlKey(url);
  upsertJob({
    urlKey: key,
    url,
    company: 'Acme',
    title: 'Frontend Engineer',
    status: 'queued',
  });
  const changed = reportOutcome(key, 'applied', 'success page confirmed', 'browser', {
    ats: 'greenhouse',
    resumeVariant: 'react',
    resumePath: 'output/resumes/react.pdf',
    durationMs: 12345,
  });
  assert.equal(changed, true);
  const row = openDb().prepare('SELECT * FROM applications ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.ats, 'greenhouse');
  assert.equal(row.resume_variant, 'react');
  assert.equal(row.resume_path, 'output/resumes/react.pdf');
  assert.equal(row.duration_ms, 12345);
  assert.equal(row.outcome, 'applied');
});

test('priority queue claims highest-priority job and can release the lease', () => {
  const lowUrl = 'https://jobs.example.com/role/low';
  const highUrl = 'https://jobs.example.com/role/high';
  upsertJob({
    urlKey: normalizeUrlKey(lowUrl), url: lowUrl, company: 'Low', title: 'Role',
    priority: 10, status: 'queued',
  });
  upsertJob({
    urlKey: normalizeUrlKey(highUrl), url: highUrl, company: 'High', title: 'Role',
    priority: 90, status: 'queued',
  });

  const claimed = claimNextJob('test-worker', 5);
  assert.equal(claimed.url_key, normalizeUrlKey(highUrl));
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claim_owner, 'test-worker');
  assert.equal(releaseClaim(claimed.url_key, 'test-worker'), true);

  const released = openDb().prepare('SELECT * FROM jobs WHERE url_key=?').get(claimed.url_key);
  assert.equal(released.status, 'queued');
});

test('job observability columns exist after additive migration', () => {
  const cols = new Set(openDb().prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
  for (const name of ['priority', 'rank_reasons_json', 'posted_at', 'claimed_at', 'claim_owner', 'claim_until']) {
    assert.equal(cols.has(name), true, name);
  }
});

test('unknown job does not create an orphan application attempt', () => {
  const before = openDb().prepare('SELECT COUNT(*) AS n FROM applications').get().n;
  const changed = reportOutcome('https://missing.example/job', 'failed', 'missing', 'browser', {
    ats: 'unknown',
    resumeVariant: 'react',
  });
  const after = openDb().prepare('SELECT COUNT(*) AS n FROM applications').get().n;
  assert.equal(changed, false);
  assert.equal(after, before);
});

test('analytics groups outcomes and resume variants', () => {
  const stats = applicationAnalytics();
  assert.ok(stats.total >= 1);
  assert.equal(stats.applied, 1);
  assert.equal(stats.success_rate, 1);
  assert.ok(stats.by_resume.some((row) => row.name === 'react' && row.n === 1));
  assert.ok(stats.by_ats.some((row) => row.name === 'greenhouse' && row.n === 1));
});

test.after(() => {
  try { openDb().close(); } catch {}
  rmSync(ROOT, { recursive: true, force: true });
});

test('claim-aware reporting is single-owner and single-finalization', () => {
  const url = 'https://jobs.example.com/role/claimed-report';
  const key = normalizeUrlKey(url);
  upsertJob({
    urlKey: key, url, company: 'Claimed', title: 'Engineer',
    priority: 100, status: 'queued',
  });
  const claimed = claimNextJob('owner-a', 5);
  assert.equal(claimed.url_key, key);
  assert.equal(renewClaim(key, 'owner-b', 5), null);
  assert.ok(renewClaim(key, 'owner-a', 5));

  assert.equal(reportOutcome(key, 'failed', 'network', 'browser', {
    claimOwner: 'owner-b',
  }), false);
  assert.equal(reportOutcome(key, 'failed', 'network', 'browser', {
    claimOwner: 'owner-a',
  }), true);

  const attempts = openDb()
    .prepare('SELECT COUNT(*) AS n FROM applications WHERE job_url_key=?')
    .get(key).n;
  assert.equal(attempts, 1);

  // The claim was cleared by the first finalization, so replaying the report
  // cannot append another application row.
  assert.equal(reportOutcome(key, 'failed', 'duplicate', 'browser', {
    claimOwner: 'owner-a',
  }), false);
  const after = openDb()
    .prepare('SELECT COUNT(*) AS n FROM applications WHERE job_url_key=?')
    .get(key).n;
  assert.equal(after, 1);
});
