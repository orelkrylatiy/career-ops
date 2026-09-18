import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMarketRegistry, registryStats, exportCompanySeeds } from '../market-sources.mjs';

test('RU registry contains the complete ranked top 200 with sequential ranks', () => {
  const { markets } = loadMarketRegistry(['RU']);
  const ru = markets[0];
  assert.equal(ru.ranked_count, 200);
  assert.deepEqual(
    ru.companies.slice(0, 200).map(c => c.rank),
    Array.from({ length: 200 }, (_, i) => i + 1),
  );
  assert.ok(ru.extra_count >= 20, 'large digital employers should widen the vendor ranking');
});

test('KZ AM UZ each have a meaningful employer seed universe', () => {
  const { markets } = loadMarketRegistry(['KZ', 'AM', 'UZ']);
  for (const market of markets) {
    const names = market.companies.map(c => String(c.name || '').trim()).filter(Boolean);
    assert.ok(names.length >= 45, market.country + ' should have at least 45 company seeds');
    assert.equal(new Set(names.map(n => n.toLowerCase())).size, names.length, market.country + ' company names must be unique');
  }
});

test('aggregator registry is country-scoped, unique and uses absolute HTTPS URLs', () => {
  const registry = loadMarketRegistry();
  const ids = registry.aggregators.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('enbek-kz'));
  assert.ok(ids.includes('staff-am'));
  assert.ok(ids.includes('ishkop-uz'));
  assert.ok(ids.includes('getmatch'));
  for (const source of registry.aggregators) {
    assert.match(source.url, /^https:\/\//);
    assert.ok(['RU', 'KZ', 'AM', 'UZ'].includes(source.country));
    assert.ok(Array.isArray(source.languages) && source.languages.length > 0);
  }
});

test('all explicit career URLs are safe absolute HTTPS seeds', () => {
  const registry = loadMarketRegistry();
  for (const market of registry.markets) {
    for (const company of market.companies) {
      if (company.career_url) assert.match(company.career_url, /^https:\/\//, company.name);
    }
  }
});

test('export preserves country and language fallback metadata for ATS discovery', () => {
  const registry = loadMarketRegistry();
  const payload = exportCompanySeeds(registry);
  assert.ok(payload.companies.length >= 350);
  const kaspi = payload.companies.find(c => c.name === 'Kaspi.kz');
  assert.equal(kaspi.market, 'KZ');
  assert.deepEqual(kaspi.application_languages, ['ru', 'kk', 'en']);
  const servicetitan = payload.companies.find(c => c.name === 'ServiceTitan');
  assert.equal(servicetitan.market, 'AM');
  assert.deepEqual(servicetitan.application_languages, ['en', 'hy', 'ru']);
});

test('stats expose breadth instead of a configured application quota', () => {
  const stats = registryStats(loadMarketRegistry());
  assert.ok(stats.companies >= 350);
  assert.ok(stats.aggregators >= 15);
  assert.equal(Object.prototype.hasOwnProperty.call(stats, 'max_applications'), false);
});
