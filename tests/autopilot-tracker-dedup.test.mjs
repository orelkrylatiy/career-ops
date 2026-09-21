import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrackerUrlIndex } from '../autopilot.mjs';
import { normalizeUrl } from '../url-key.mjs';

test('tracker dedup only blocks rows that prove a prior submission', () => {
  const tracker = `
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-09-20 | Seen Only | Engineer | 3.0/5 | Evaluated | ❌ | — | research only | https://jobs.example.com/evaluated |
| 2 | 2026-09-20 | Skipped | Engineer | 2.0/5 | SKIP | ❌ | — | old preference skip | https://jobs.example.com/skip |
| 3 | 2026-09-20 | Sent | Engineer | N/A | Applied | ✅ | — | sent | https://jobs.example.com/applied?utm_source=x |
| 4 | 2026-09-20 | Interviewing | Engineer | N/A | Interview | ✅ | — | active | https://jobs.example.com/interview |
| 5 | 2026-09-20 | Rejected | Engineer | N/A | Rejected | ✅ | — | company rejected | https://jobs.example.com/rejected |
`;

  const index = loadTrackerUrlIndex(tracker);
  assert.equal(index.keySet.has(normalizeUrl('https://jobs.example.com/evaluated')), false);
  assert.equal(index.keySet.has(normalizeUrl('https://jobs.example.com/skip')), false);
  assert.equal(index.keySet.has(normalizeUrl('https://jobs.example.com/applied')), true);
  assert.equal(index.keySet.has(normalizeUrl('https://jobs.example.com/interview')), true);
  assert.equal(index.keySet.has(normalizeUrl('https://jobs.example.com/rejected')), true);
});

test('legacy tracker without URL column can still recover a submitted job URL from its row', () => {
  const tracker = `
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-09-20 | Acme | Engineer | N/A | Applied | ✅ | — | submitted https://jobs.example.com/legacy |
| 2 | 2026-09-20 | Other | Engineer | 3.0/5 | Evaluated | ❌ | — | https://jobs.example.com/not-sent |
`;
  const index = loadTrackerUrlIndex(tracker);
  assert.equal(index.keySet.has(normalizeUrl('https://jobs.example.com/legacy')), true);
  assert.equal(index.keySet.has(normalizeUrl('https://jobs.example.com/not-sent')), false);
});
