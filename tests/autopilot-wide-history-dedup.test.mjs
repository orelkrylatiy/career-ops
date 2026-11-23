import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSeenUrls, normalizeUrlForDedup } from '../scan.mjs';
import { loadTrackerUrlIndex } from '../autopilot.mjs';

const APPLICATIONS = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-01 | Seen Co | Engineer | 3.0/5 | Evaluated | — | — | viewed only | https://jobs.example.com/evaluated |
| 2 | 2026-09-01 | Applied Co | Engineer | 4.0/5 | Applied | ✅ | — | sent | https://jobs.example.com/applied |
| 3 | 2026-09-01 | Skip Co | Engineer | 2.0/5 | SKIP | — | — | skipped | https://jobs.example.com/skip |
`;

const key = (url) => normalizeUrlForDedup('https://jobs.example.com/' + url);

test('fork Autopilot checks submitted tracker entries only, without modifying upstream scan', () => {
  const { keySet } = loadTrackerUrlIndex(APPLICATIONS);
  assert.equal(keySet.has(key('applied')), true);
  assert.equal(keySet.has(key('evaluated')), false);
  assert.equal(keySet.has(key('skip')), false);
});

test('upstream scan still treats all tracker URLs as seen to avoid duplicate discovery', () => {
  const { seen } = collectSeenUrls({ applicationsText: APPLICATIONS });
  assert.equal(seen.has(key('applied')), true);
  assert.equal(seen.has(key('evaluated')), true);
  assert.equal(seen.has(key('skip')), true);
});

test('upstream scan recheck TTL releases old processed history, not pending queue', () => {
  const history = [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
    'https://jobs.example.com/old-seen\t2026-09-01\tgreenhouse\tEngineer\tOld\tadded\tRemote',
    '',
  ].join('\n');
  const pipeline = [
    '# Pipeline',
    '## Pending',
    '- [ ] https://jobs.example.com/pending | Pending Co | Engineer',
    '',
    '## Processed',
    '- [x] https://jobs.example.com/old-seen | Old | Engineer',
    '',
  ].join('\n');
  const { seen } = collectSeenUrls(
    { scanHistoryText: history, pipelineText: pipeline },
    { recheckAfterDays: 0, today: '2026-09-21' },
  );
  assert.equal(seen.has(key('old-seen')), false);
  assert.equal(seen.has(key('pending')), true);
});
