import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'career-ops-autopilot-test-'));
mkdirSync(join(root, 'config'), { recursive: true });
mkdirSync(join(root, 'data'), { recursive: true });
mkdirSync(join(root, 'output'), { recursive: true });
writeFileSync(join(root, 'config', 'profile.yml'), [
  'candidate:',
  '  email: test@example.net',
  '  phone: ""',
  'autopilot:',
  '  max_applications_per_day: 2',
  '  remote_only: true',
  '  blocked_locations: [LATAM]',
  '  cv_pdf: output/cv.pdf',
].join('\n') + '\n');
writeFileSync(join(root, 'output', 'cv.pdf'), '%PDF-test\n');
writeFileSync(join(root, 'portals.yml'), 'title_filter:\n  positive: [engineer]\n  negative: [principal]\n');
writeFileSync(join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n');
writeFileSync(join(root, 'data', 'applications.md'), '# Applications\n');

process.env.CAREER_OPS_ROOT = root;
process.env.CAREER_OPS_AUTOPILOT_DB = join(root, 'data', 'autopilot-test.db');
process.env.CAREER_OPS_PROFILE = join(root, 'config', 'profile.yml');
process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
process.env.CAREER_OPS_PIPELINE = join(root, 'data', 'pipeline.md');
process.env.CAREER_OPS_TRACKER = join(root, 'data', 'applications.md');

const core = await import('../autopilot.mjs');
const dbmod = await import('../autopilot-db.mjs');
const browser = await import('../autopilot-browser.mjs');

after(() => {
  try { dbmod.openDb().close(); } catch {}
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
});

test('pipeline parser and title gate stay deterministic', () => {
  const rows = core.parsePipelinePending([
    '# Pipeline',
    '',
    '## Pending',
    '- [ ] https://jobs.example/a | Acme | Backend Engineer | Remote | posted: 2026-09-18',
    '- [ ] ~~https://jobs.example/dead | Dead | Engineer~~',
    '',
    '## Done',
  ].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Acme');
  assert.equal(core.gateTitle('Backend Engineer', { positive: ['engineer'], negative: [] }).ok, true);
  assert.equal(core.gateTitle('Principal Engineer', { positive: ['engineer'], negative: ['principal'] }).ok, false);
});

test('location policy is configuration-driven, not country-hardcoded', () => {
  assert.equal(core.gateLocation('Berlin (hybrid)', { remoteOnly: true, blocked: [] }).ok, false);
  assert.equal(core.gateLocation('Chile — Remote', { remoteOnly: true, blocked: [] }).ok, true);
  assert.equal(core.gateLocation('Chile — Remote', { remoteOnly: false, blocked: ['chile'] }).ok, false);
});

test('source host exclusions respect DNS-label boundaries', () => {
  assert.equal(core.hostMatchesToken('jobs.linkedin.com', 'linkedin.com'), true);
  assert.equal(core.hostMatchesToken('linkedin.com', 'linkedin.com'), true);
  assert.equal(core.hostMatchesToken('notlinkedin.com', 'linkedin.com'), false);
});

test('application claims reserve the daily cap atomically and applied reporting is idempotent', () => {
  const a = 'https://jobs.example/a';
  const b = 'https://jobs.example/b';
  const ka = dbmod.normalizeUrlKey(a);
  const kb = dbmod.normalizeUrlKey(b);
  dbmod.upsertJob({ urlKey: ka, url: a, company: 'Acme', title: 'Engineer A' });
  dbmod.upsertJob({ urlKey: kb, url: b, company: 'Beta', title: 'Engineer B' });

  const claimA = dbmod.claimApplication(ka, '2026-09-18', 1, 45);
  assert.equal(claimA.allowed, true);
  const claimB = dbmod.claimApplication(kb, '2026-09-18', 1, 45);
  assert.deepEqual({ allowed: claimB.allowed, reason: claimB.reason }, { allowed: false, reason: 'daily-cap' });

  const applied = dbmod.reportApplied(ka, 'ok', 'browser', '2026-09-18', claimA.token);
  assert.equal(applied.ok, true);
  assert.equal(applied.duplicate, false);
  assert.equal(applied.dailyRow.applications_sent, 1);

  const retry = dbmod.reportApplied(ka, 'ok', 'browser', '2026-09-18', claimA.token);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.dailyRow.applications_sent, 1);

  const attempts = dbmod.openDb().prepare('SELECT COUNT(*) AS n FROM applications WHERE job_url_key = ?').get(ka).n;
  assert.equal(attempts, 1);
});

test('non-applied outcome retries do not duplicate attempt rows', () => {
  const url = 'https://jobs.example/c';
  const key = dbmod.normalizeUrlKey(url);
  dbmod.upsertJob({ urlKey: key, url, company: 'Gamma', title: 'Engineer C' });
  assert.equal(dbmod.reportOutcome(key, 'failed', 'form_error', 'browser'), true);
  assert.equal(dbmod.reportOutcome(key, 'failed', 'form_error', 'browser'), true);
  const attempts = dbmod.openDb().prepare('SELECT COUNT(*) AS n FROM applications WHERE job_url_key = ?').get(key).n;
  assert.equal(attempts, 1);
});

test('browser network guard blocks local/private IPs', () => {
  assert.equal(browser.isBlockedIp('127.0.0.1', 4), true);
  assert.equal(browser.isBlockedIp('10.1.2.3', 4), true);
  assert.equal(browser.isBlockedIp('::1', 6), true);
  assert.equal(browser.isBlockedIp('8.8.8.8', 4), false);
});

test('upload resolver honors external data root and rejects escapes', () => {
  const cv = join(root, 'output', 'cv.pdf');
  assert.equal(browser.resolveUploadPath('output/cv.pdf'), realpathSync(cv));
  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'secret');
  assert.throws(() => browser.resolveUploadPath('secret.txt'), /must resolve under/);

  if (process.platform !== 'win32') {
    const link = join(root, 'output', 'escape.txt');
    symlinkSync(secret, link);
    assert.throws(() => browser.resolveUploadPath('output/escape.txt'), /must resolve under/);
  }
});

test('safe URL validation rejects loopback before browser navigation', async () => {
  await assert.rejects(() => browser.assertSafeUrl('http://127.0.0.1:8080/private'), /non-public/);
});
