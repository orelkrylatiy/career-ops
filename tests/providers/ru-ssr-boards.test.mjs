import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHabrState, parseHabrState } from '../../providers/habr-career.mjs';
import {
  extractSuperjobUrls,
  parseSuperjobListing,
  titleFromSuperjobUrl,
} from '../../providers/superjob.mjs';

test('habr parser reads vacancies out of the SSR state blob', () => {
  const state = {
    vacancies: {
      list: [
        {
          id: 1000168750,
          href: '/vacancies/1000168750',
          title: 'Head of Frontend / Head of UI',
          isMarked: true,
          remoteWork: true,
          salaryQualification: { title: 'Ведущий (Lead)', href: '/vacancies?qid=6' },
          publishedDate: { date: '2026-10-17T20:27:13+03:00', title: '17 октября' },
          location: null,
          company: { id: 1000093994, alias_name: 'ithunter', href: '/companies/ithunter', title: 'IT Hunter' },
        },
        { id: 2, title: '', href: '/vacancies/2' },
        null,
      ],
    },
  };
  const html = `<html><head><script type="application/json">${JSON.stringify(state)}</script></head></html>`;
  const extracted = extractHabrState(html);
  assert.ok(extracted);
  const jobs = parseHabrState(extracted);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Head of Frontend / Head of UI');
  assert.equal(jobs[0].url, 'https://career.habr.com/vacancies/1000168750');
  assert.equal(jobs[0].company, 'IT Hunter');
  assert.equal(jobs[0].location, '');
  assert.equal(jobs[0].postedAt, Date.parse('2026-10-17T20:27:13+03:00'));
  assert.match(jobs[0].description, /удалённо/);
  assert.match(jobs[0].description, /Ведущий \(Lead\)/);
  assert.equal(jobs[0].externalId, '1000168750');
});

test('habr extractor returns null when the page has no vacancy state', () => {
  assert.equal(extractHabrState('<html><script type="application/json">{"a":1}</script></html>'), null);
  assert.equal(extractHabrState('<html>no scripts</html>'), null);
});

test('superjob parser reads ItemList urls and derives slug titles', () => {
  const html = `
    <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","position":1,"url":"https://www.superjob.ru/vakansii/frontend-razrabotchik-52192677.html"},
      {"@type":"ListItem","position":2,"url":"https://www.superjob.ru/vakansii/razrabotchik-python-52190001.html"}
    ]}</script>
  `;
  const urls = extractSuperjobUrls(html);
  assert.deepEqual(urls, [
    'https://www.superjob.ru/vakansii/frontend-razrabotchik-52192677.html',
    'https://www.superjob.ru/vakansii/razrabotchik-python-52190001.html',
  ]);
  assert.equal(titleFromSuperjobUrl(urls[0]), 'frontend razrabotchik');
  const jobs = parseSuperjobListing(html);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].externalId, '52192677');
  assert.equal(jobs[1].title, 'razrabotchik python');
  assert.equal(jobs[0].company, '');
});

test('superjob title falls back to empty for non-vacancy urls', () => {
  assert.equal(titleFromSuperjobUrl('https://www.superjob.ru/rabota/'), '');
});
