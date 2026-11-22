import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = mkdtempSync(path.join(tmpdir(), 'career-ops-campaign-dispatch-'));
const put = (relative, text) => {
  const target = path.join(ROOT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
};

put('config/profile.yml', `candidate:
  email: applied@candidate.test
location:
  country: Россия
  city: Москва
autopilot:
  strict_market: Russia
  cv_pdf: data/mock.pdf
  priority_sources: [jobs.junkcorp.ru]
`);
put('cv.md', '# Candidate CV\\nContact: other@candidate.test\\n');
put('data/mock.pdf', '%PDF-1.4\\n% fixture (no real CV)\\n');
put('portals.yml', `title_filter:
  positive: [react]
  negative: [sales]
`);
put('data/pipeline.md', `# Pipeline

## Pending

- [ ] https://jobs.junkcorp.ru/sales | Junk Corp | Sales Manager | Москва, Россия, Remote
- [ ] https://careers.valid.com/react | Good Corp | React Developer | Россия
`);
process.env.CAREER_OPS_ROOT = ROOT;
process.env.CAREER_OPS_PROFILE = path.join(ROOT, 'config/profile.yml');
process.env.CAREER_OPS_PORTALS = path.join(ROOT, 'portals.yml');
process.env.CAREER_OPS_PIPELINE = path.join(ROOT, 'data/pipeline.md');

const autopilot = await import(pathToFileURL(path.join(CODE_ROOT, 'autopilot.mjs')).href + '?campaign=' + Date.now());
const db = await import(pathToFileURL(path.join(CODE_ROOT, 'autopilot-db.mjs')).href);

test('preflight rejects mismatched CV/profile email before live submission', () => {
  assert.match(autopilot.contactPreflight().join(' | '), /conflicts with cv\\.md/);
  const matching = autopilot.applicationContactIssues(
    { candidate: { email: 'applied@candidate.test' } },
    'Contact: applied@candidate.test',
  );
  assert.deepEqual(matching, []);
  assert.equal(autopilot.applicationContactIssues(
    { candidate: { email: 'applied@candidate.test' } },
    'Contact: different@candidate.test',
  ).length, 1);
});

test('wide discovery retains both jobs, but live dispatch skips an unrelated high-priority job', async () => {
  process.env.AUTOPILOT_QUEUE_VIEW_LIMIT = '1';
  const summary = await autopilot.cmdRun({ noScan: true, dryRun: false });
  assert.equal(summary.queuedNew, 2);
  const queued = db.listJobs('queued');
  assert.equal(queued.length, 2);
  assert.equal(queued[0].company, 'Junk Corp', 'irrelevant job must be the highest-ranked to test dispatch filtering');
  const view = readFileSync(path.join(ROOT, 'data/autopilot-queue.md'), 'utf8');
  assert.match(view, /Showing: 1 of 2/);
  assert.doesNotMatch(view, /Good Corp/);

  const previousLive = process.env.AUTOPILOT_LIVE;
  process.env.AUTOPILOT_LIVE = '1';
  try {
    const claimed = autopilot.cmdNext({ owner: 'campaign-fixture' });
    assert.equal(claimed.company, 'Good Corp');
    const jobs = db.listJobs();
    assert.equal(jobs.find(j => j.company === 'Junk Corp')?.status, 'skipped');
    assert.equal(jobs.find(j => j.company === 'Good Corp')?.status, 'claimed');
  } finally {
    if (previousLive == null) delete process.env.AUTOPILOT_LIVE;
    else process.env.AUTOPILOT_LIVE = previousLive;
    delete process.env.AUTOPILOT_QUEUE_VIEW_LIMIT;
  }
});

test('router advertises autopilot separately from upstream review-only apply', () => {
  const skill = readFileSync(path.join(CODE_ROOT, '.agents/skills/career-ops/SKILL.md'), 'utf8');
  const guide = readFileSync(path.join(CODE_ROOT, 'AGENTS.md'), 'utf8');
  assert.match(skill, /\/career-ops autopilot/);
  assert.match(skill, /autonomous campaign routing/i);
  assert.match(skill, /autopilot:live/);
  assert.match(guide, /dedicated \`autopilot-runner\\.mjs\`/);
});

test.after(() => {
  try { db.openDb().close(); } catch {}
  rmSync(ROOT, { recursive: true, force: true });
});
