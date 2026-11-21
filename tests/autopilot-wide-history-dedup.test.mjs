import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSeenUrls,
  collectSubmittedTrackerUrls,
  normalizeUrlForDedup,
} from '../scan.mjs';

const APPLICATIONS = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-01 | Seen Co | Engineer | 3.0/5 | Evaluated | — | — | viewed only | https://jobs.example.com/evaluated |
| 2 | 2026-09-01 | Applied Co | Engineer | 4.0/5 | Applied | ✅ | — | sent | https://jobs.example.com/applied |
| 3 | 2026-09-01 | Skip Co | Engineer | 2.0/5 | SKIP | — | — | skipped | https://jobs.example.com/skip |
`;

test('submitted-only tracker dedup ignores evaluated and skipped rows', () => {
  const seen = collectSubmittedTrackerUrls(APPLICATIONS);
  assert.deepEqual([...seen], ['https://jobs.example.com/applied']);
});

test('wide dedup releases old scan-history added rows but keeps pending queue and real applications', () => {
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
    { scanHistoryText: history, pipelineText: pipeline, applicationsText: APPLICATIONS },
    { recheckAfterDays: 0, today: '2026-09-21' },
    { applicationsMode: 'submitted' },
  );

  assert.equal(seen.has(normalizeUrlForDedup('https://jobs.example.com/old-seen')), false);
  assert.equal(seen.has(normalizeUrlForDedup('https://jobs.example.com/pending')), true);
  assert.equal(seen.has(normalizeUrlForDedup('https://jobs.example.com/applied')), true);
  assert.equal(seen.has(normalizeUrlForDedup('https://jobs.example.com/evaluated')), false);
  assert.equal(seen.has(normalizeUrlForDedup('https://jobs.example.com/skip')), false);
});
