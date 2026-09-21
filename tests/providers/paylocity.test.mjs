import test from 'node:test';
import assert from 'node:assert/strict';
import paylocity, { parsePaylocityPage, resolvePaylocityGuid } from '../../providers/paylocity.mjs';

const guid = '5cc86a46-fa67-4c3d-9618-443235d66fd4';

test('detects public Paylocity tenant URL', () => {
  const hit = paylocity.detect({
    name: 'Acme',
    careers_url: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/`,
  });
  assert.equal(hit?.url, `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/`);
  assert.equal(resolvePaylocityGuid({ paylocity: guid }), guid);
});

test('rejects off-domain and malformed tenant identifiers', () => {
  assert.equal(paylocity.detect({ careers_url: `https://evil.example/recruiting/jobs/All/${guid}/` }), null);
  assert.equal(resolvePaylocityGuid({ paylocity: '../../etc/passwd' }), null);
});

test('parses pageData into normalized jobs', () => {
  const pageData = {
    Jobs: [
      {
        JobId: 101,
        JobTitle: 'Frontend Engineer',
        JobLocation: { City: 'Austin', State: 'TX' },
        IsRemote: true,
        PublishedDate: '2026-09-20T12:00:00Z',
        Description: '<p>Build <strong>React</strong> products</p>',
      },
      { JobId: null, JobTitle: 'No stable id' },
    ],
  };
  const html = `<script>window.pageData = ${JSON.stringify(pageData)};</script>`;
  const jobs = parsePaylocityPage(html, 'Acme');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Frontend Engineer');
  assert.equal(jobs[0].location, 'Austin, TX, Remote');
  assert.equal(jobs[0].description, 'Build React products');
  assert.equal(jobs[0].url, 'https://recruiting.paylocity.com/recruiting/Jobs/Details/101');
  assert.equal(jobs[0].postedAt, Date.parse('2026-09-20T12:00:00Z'));
});

test('pageData scanner handles braces and semicolons inside strings', () => {
  const payload = { Jobs: [{ JobId: 'A1', JobTitle: 'Engineer } ; still title', Description: '{"x":1};' }] };
  const html = `<script>window.pageData = ${JSON.stringify(payload)};</script>`;
  assert.equal(parsePaylocityPage(html, 'Acme')?.length, 1);
});

test('fetch pins host and rejects a page without pageData', async () => {
  await assert.rejects(
    () => paylocity.fetch(
      { name: 'Acme', paylocity: guid },
      { fetchText: async () => '<html>No data</html>' },
    ),
    /pageData/,
  );
});
