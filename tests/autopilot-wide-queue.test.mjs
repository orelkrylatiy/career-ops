import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(path.join(tmpdir(), 'career-ops-wide-queue-'));
mkdirSync(path.join(ROOT, 'config'), { recursive: true });
mkdirSync(path.join(ROOT, 'data'), { recursive: true });

writeFileSync(path.join(ROOT, 'portals.yml'), `
title_filter:
  positive: [react, frontend]
  negative: [sales]
`, 'utf8');

writeFileSync(path.join(ROOT, 'config', 'profile.yml'), `
candidate:
  email: real@example.net
location:
  country: Russia
  city: Moscow
autopilot:
  remote_only: true
  blocked_locations: [London]
`, 'utf8');

writeFileSync(path.join(ROOT, 'data', 'pipeline.md'), `
# Pipeline

## Pending

- [ ] https://jobs.example.com/react | Good Co | Senior React Engineer | Remote, Russia | posted: 2026-09-20
- [ ] https://jobs.example.com/sales | Weak Co | Sales Operations Manager | London hybrid | posted: 2026-09-20
- [ ] https://jobs.example.com/other | Other Co | Laboratory Coordinator | Onsite, Berlin | posted: 2026-09-20
- [ ] https://jobs.example.com/blacklisted | Blocked Co | React Engineer | Remote | posted: 2026-09-20
`, 'utf8');

writeFileSync(path.join(ROOT, 'data', 'blacklist.md'), `
| Company | Since | Scope | Reason |
|---|---|---|---|
| Blocked Co | 2026-09-01 | all | explicit user choice |
`, 'utf8');

process.env.CAREER_OPS_ROOT = ROOT;
process.env.CAREER_OPS_PORTALS = path.join(ROOT, 'portals.yml');
process.env.CAREER_OPS_PROFILE = path.join(ROOT, 'config', 'profile.yml');
process.env.CAREER_OPS_PIPELINE = path.join(ROOT, 'data', 'pipeline.md');

const autopilot = await import(
  pathToFileURL(path.resolve('autopilot.mjs')).href + '?wide=' + Date.now()
);
// autopilot.mjs imports this exact URL internally; importing it without a
// cache-busting query gives the test the SAME DB handle so Windows cleanup can
// close it before removing the temporary directory.
const dbMod = await import(
  pathToFileURL(path.resolve('autopilot-db.mjs')).href
);

test('wide queue keeps weak title/location matches and only hard-stops explicit blacklist', async () => {
  const counts = await autopilot.cmdRun({ noScan: true, dryRun: false });
  assert.equal(counts.pending, 4);
  assert.equal(counts.queuedNew, 3);
  assert.equal(counts.hardSkipped, 1);

  const rows = dbMod.openDb()
    .prepare('SELECT company, title, priority, status FROM jobs ORDER BY priority DESC')
    .all();
  assert.deepEqual(rows.map((r) => r.company).sort(), ['Good Co', 'Other Co', 'Weak Co']);
  assert.ok(rows.every((r) => r.status === 'queued'));

  const good = rows.find((r) => r.company === 'Good Co');
  const weak = rows.find((r) => r.company === 'Weak Co');
  assert.ok(good.priority > weak.priority);
});

test.after(() => {
  try { dbMod.openDb().close(); } catch {}
  rmSync(ROOT, { recursive: true, force: true });
});
