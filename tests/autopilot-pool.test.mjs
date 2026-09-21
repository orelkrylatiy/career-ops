import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES } from '../scan-ats-full.mjs';

test('reverse ATS sweep includes BambooHR public tenant directory', () => {
  const source = SOURCES.bamboohr;
  assert.ok(source);
  assert.equal(source.provider.id, 'bamboohr');
  assert.match(source.dataset, /bamboohr_companies\.json$/);
  assert.equal(source.concurrency, 10);

  const entry = source.toEntry('acme-company');
  assert.deepEqual(entry, {
    name: 'acme-company',
    careers_url: 'https://acme-company.bamboohr.com/careers',
  });
});

test('BambooHR reverse source refuses unsafe tenant identifiers', () => {
  assert.equal(SOURCES.bamboohr.toEntry('../internal'), null);
  assert.equal(SOURCES.bamboohr.toEntry('evil/example'), null);
  assert.equal(SOURCES.bamboohr.toEntry(''), null);
});
