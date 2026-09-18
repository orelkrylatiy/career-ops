import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTrudvsemResponse } from '../../providers/trudvsem.mjs';
import { parseStaffAmListing } from '../../providers/staffam.mjs';
import { parseCareerCenterListing } from '../../providers/careercenter-am.mjs';
import { parseIshUzListing } from '../../providers/ishuz.mjs';

test('trudvsem parser normalizes official open-data vacancy shape', () => {
  const jobs = parseTrudvsemResponse({
    status: '200',
    meta: { total: '1' },
    results: {
      vacancies: [{
        vacancy: {
          id: 'v-42',
          'job-name': 'Backend разработчик',
          company: { name: 'ООО Тест', companycode: 'c-7' },
          region: { name: 'Москва' },
          addresses: { address: [{ location: 'Москва', street: 'Тверская' }] },
          'creation-date': '2026-09-17T10:00:00Z',
          vac_url: 'https://trudvsem.ru/vacancy/card/c-7/v-42',
          duty: 'Node.js',
        },
      }],
    },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Backend разработчик');
  assert.equal(jobs[0].company, 'ООО Тест');
  assert.match(jobs[0].location, /Москва/);
  assert.equal(jobs[0].externalId, 'v-42');
  assert.equal(jobs[0].description, 'Node.js');
});

test('staff.am parser extracts job, company, location and date from a card', () => {
  const html = `
    <article>
      <a href="/en/jobs/software-development/backend-engineer">Backend Engineer</a>
      <a href="/company/acme">Acme Armenia</a>
      <span>17 September 2026</span>
      <span>Yerevan</span>
    </article>
  `;
  const jobs = parseStaffAmListing(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Backend Engineer');
  assert.equal(jobs[0].company, 'Acme Armenia');
  assert.equal(jobs[0].location, 'Yerevan');
  assert.equal(new Date(jobs[0].postedAt).toISOString().slice(0, 10), '2026-09-17');
});

test('CareerCenter parser keeps stable detail URL and employer text', () => {
  const html = `
    <div class="job">
      <a href="/en/jobs/software-engineer-3dic">Software Engineer – 3DIC</a>
      <a href="/en/companies/siemens-industry-software">Siemens Industry Software</a>
      <span>17 September 2026</span>
      <span>Yerevan</span>
    </div>
  `;
  const jobs = parseCareerCenterListing(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Software Engineer – 3DIC');
  assert.equal(jobs[0].company, 'Siemens Industry Software');
  assert.equal(jobs[0].location, 'Yerevan, Armenia');
});

test('ish.uz parser uses numeric vacancy id for dedup identity', () => {
  const html = `
    <section>
      <a href="/oz/jobs-andijan-retail/4490">QA mutaxassisi</a>
      <div>5 000 000 - 6 000 000 so'm</div>
      <div>Uniplatforms</div>
      <div>Toshkent</div>
    </section>
  `;
  const jobs = parseIshUzListing(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'QA mutaxassisi');
  assert.equal(jobs[0].externalId, '4490');
  assert.match(jobs[0].url, /\/4490$/);
  assert.equal(jobs[0].location, 'Toshkent');
});

test('regional parsers fail closed when known job markup stops parsing', () => {
  assert.throws(
    () => parseStaffAmListing('<a href="/jobs/software-development/x"></a>'),
    /parser produced zero/i,
  );
  assert.throws(
    () => parseIshUzListing('<a href="/jobs-something/123"></a>'),
    /parser produced zero/i,
  );
});
