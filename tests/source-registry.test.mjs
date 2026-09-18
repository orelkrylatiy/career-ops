import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCnews500,
  parseAstanaHubParticipants,
  parseEifItGuide,
  parseItParkResidents,
  normalizeCompanyKey,
  healthKind,
} from '../catalog/registry-core.mjs';
import {
  careerPageEvidence,
  commonCareerCandidates,
  extractCareerLinks,
  extractExternalWebsiteCandidates,
} from '../catalog/career-discovery-core.mjs';

test('CNews500 parser keeps rank and treats top-200 as priority metadata only', () => {
  const html = `
    <table>
      <tr><td>1</td><td>4</td><td>Ростелеком (цифровые сервисы)</td><td>217854</td></tr>
      <tr><td>200</td><td>—</td><td>Компания 200</td><td>100</td></tr>
      <tr><td>201</td><td>—</td><td>Компания 201</td><td>99</td></tr>
    </table>
  `;
  const rows = parseCnews500(html, 'https://www.cnews.ru/table');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].priority, true);
  assert.equal(rows[2].priority, false);
});

test('Astana Hub participant parser preserves active status and BIN identity', () => {
  const html = `
    <table><tr>
      <td>1234</td><td>01.01.2025</td><td>01.01.2035</td>
      <td>990123456789</td><td>Активно</td><td>ТОО Example Tech</td>
    </tr></table>
  `;
  const rows = parseAstanaHubParticipants(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalId, '990123456789');
  assert.equal(rows[0].status, 'Активно');
  assert.equal(rows[0].name, 'ТОО Example Tech');
});

test('EIF parser extracts company detail anchors instead of navigation', () => {
  const html = `
    <a href="index.php?catid=5&id=482&lang=0">CodeRiders LLC</a>
    <a href="/">Home</a>
  `;
  const rows = parseEifItGuide(html, 'https://itguide.eif.am/');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'CodeRiders LLC');
  assert.match(rows[0].directoryUrl, /id=482/);
});

test('IT Park resident parser keeps all register rows without a top-N cutoff', () => {
  const html = `
    <table>
      <tr><td>1</td><td>"EXACTIT" MAS'ULIYATI CHEKLANGAN JAMIYAT</td><td>306761917</td><td>Tashkent</td><td>Email</td><td>2019-11-04</td></tr>
      <tr><td>201</td><td>DEV EXPERTS LLC</td><td>302072804</td><td>Tashkent</td><td>Email</td><td>2021-01-01</td></tr>
    </table>
  `;
  const rows = parseItParkResidents(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].externalId, '302072804');
});

test('company normalization collapses common regional legal suffixes', () => {
  assert.equal(normalizeCompanyKey('ООО «Example Tech»'), 'example tech');
  assert.equal(normalizeCompanyKey('ТОО Example Tech'), 'example tech');
});

test('career discovery ranks explicit ATS and careers links', () => {
  const html = `
    <a href="/about">About</a>
    <a href="/careers">Careers</a>
    <a href="https://jobs.lever.co/example">Open jobs</a>
  `;
  const links = extractCareerLinks(html, 'https://example.com/');
  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'https://jobs.lever.co/example');
  assert.equal(careerPageEvidence('<h1>Careers</h1><a href="/jobs/backend">Backend jobs</a>', 'https://example.com/careers').verified, true);
});

test('directory enrichment excludes social/directory hosts from official-site candidates', () => {
  const html = `
    <a href="https://linkedin.com/company/example">LinkedIn</a>
    <a href="https://example.tech/">Website</a>
  `;
  const rows = extractExternalWebsiteCandidates(html, 'https://itguide.eif.am/company/1');
  assert.deepEqual(rows.map((r) => r.url), ['https://example.tech/']);
});

test('common career probing is finite strategy, not funnel count limit', () => {
  const candidates = commonCareerCandidates('https://example.com/');
  assert.ok(candidates.includes('https://example.com/careers'));
  assert.ok(candidates.includes('https://example.com/ru/vacancies'));
  assert.equal(new Set(candidates).size, candidates.length);
});

test('source health classification distinguishes auth/throttle/gone', () => {
  assert.equal(healthKind(200), 'reachable');
  assert.equal(healthKind(403), 'auth');
  assert.equal(healthKind(429), 'throttled');
  assert.equal(healthKind(404), 'gone');
});
