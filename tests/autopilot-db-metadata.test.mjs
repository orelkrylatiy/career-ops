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

test('analytics groups outcomes and resume variants', () => {
  const stats = applicationAnalytics();
  assert.equal(stats.total, 1);
  assert.equal(stats.applied, 1);
  assert.equal(stats.success_rate, 1);
  assert.deepEqual(stats.by_resume, [{ name: 'react', n: 1 }]);
  assert.deepEqual(stats.by_ats, [{ name: 'greenhouse', n: 1 }]);
});

test.after(() => {
  try { openDb().close(); } catch {}
  rmSync(ROOT, { recursive: true, force: true });
});
