import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWideConfig, isExcludedTransport, parseScanArgs } from '../autopilot-scan.mjs';

test('wide config removes fit filters but keeps trust and blacklist settings', () => {
  const raw = {
    title_filter: { positive: ['python'] }, location_filter: { allow: ['remote'] },
    visa_filter: { enabled: true }, domain_filter: ['ai'], trust_filter: { enabled: true },
    tracked_companies: [{ name: 'Example', url: 'https://example.org/jobs' }],
    job_boards: [{ provider: 'telegram-channel', url: 'https://t.me/jobs' },
                 { provider: 'greenhouse', url: 'https://boards.greenhouse.io/acme' }],
  };
  const wide = makeWideConfig(raw);
  assert.equal(wide.title_filter, undefined);
  assert.equal(wide.location_filter, undefined);
  assert.equal(wide.visa_filter, undefined);
  assert.deepEqual(wide.trust_filter, raw.trust_filter);
  assert.equal(wide.job_boards.length, 1);
  assert.ok(raw.title_filter, 'input must not be mutated');
});
test('HeadHunter remains excluded, unrelated hosts remain allowed', () => {
  assert.equal(isExcludedTransport({url:'https://hh.ru/vacancy/1'}), true);
  assert.equal(isExcludedTransport({url:'https://jobs.hh.ru/vacancy/1'}), true);
  assert.equal(isExcludedTransport({url:'https://t.me/jobs'}), true);
  assert.equal(isExcludedTransport({url:'https://not-hh.ru/jobs'}), false);
  assert.equal(isExcludedTransport({url:'https://example.org/jobs'}), false);
});
test('adapter selects native upstream scanners without legacy --wide', () => {
  assert.deepEqual(parseScanArgs(['--ats-full','--since','7']), {atsFull:true,args:['--since','7']});
  assert.throws(() => parseScanArgs(['--wide']), /obsolete/);
});

// The source registry is a separate activation step: a .mjs provider module
// alone does not create a configured source for scan.mjs.
test('Russian catalog providers remain configured and are not HH/Telegram', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = await import('js-yaml');
  const catalog = yaml.load(readFileSync(new URL('../catalog/source-catalog.yml', import.meta.url), 'utf8'));
  const ru = (catalog.job_sources || []).filter(row => row.country === 'RU' && row.provider);
  const ids = ru.map(row => row.provider);
  assert.ok(ids.includes('habr-career'));
  assert.ok(ids.includes('geekjob'));
  assert.ok(ids.includes('superjob'));
  assert.ok(ru.every(row => !isExcludedTransport({provider:row.provider, careers_url:row.url})));
});

test('runner actively exports and scans the Russian regional catalog', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../autopilot-runner.mjs', import.meta.url), 'utf8');
  assert.match(src, /runStep\('source-registry\.mjs', \['export', '--country', 'RU'\]\)/);
  assert.match(src, /CAREER_OPS_PORTALS: regionalPortals/);
});
