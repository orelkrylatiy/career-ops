import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScanConfig, makeWideConfig, isExcludedTransport, parseScanArgs, checkFullScanCheckpoint } from '../autopilot-scan.mjs';

test('scan preserves upstream filters by default, except explicitly forbidden transports', () => {
  const raw = {title_filter: {positive:['react']}, location_filter: {allow:['RU']}, job_boards:[{url:'https://t.me/jobs'},{url:'https://jobs.example.com'}]};
  const filtered = makeScanConfig(raw);
  assert.deepEqual(filtered.title_filter, raw.title_filter);
  assert.deepEqual(filtered.location_filter, raw.location_filter);
  assert.equal(filtered.job_boards.length, 1);
  assert.equal(filtered.job_boards[0].url, 'https://jobs.example.com');
});

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
test('adapter selects original scanner by default; --wide is explicitly opt-in', () => {
  assert.deepEqual(parseScanArgs([]), {atsFull:false,wide:false,args:[]});
  assert.deepEqual(parseScanArgs(['--ats-full','--since','7']), {atsFull:true,wide:false,args:['--since','7']});
  assert.deepEqual(parseScanArgs(['--wide','--ats-full','--since','7']), {atsFull:true,wide:true,args:['--since','7']});
});

test('full ATS scan requires explicit checkpoint disposition before overwriting work', () => {
  const exists = () => true;
  const opts = { atsFull: true, args: [] };
  assert.throws(
    () => checkFullScanCheckpoint(opts, { dataRoot: '/test-direction', exists }),
    /unfinished ATS checkpoint exists/,
  );
  assert.doesNotThrow(
    () => checkFullScanCheckpoint({ atsFull: true, args: ['--resume'] }, { dataRoot: '/test-direction', exists }),
  );
  assert.doesNotThrow(
    () => checkFullScanCheckpoint({ atsFull: true, args: ['--resume-if-compatible'] }, { dataRoot: '/test-direction', exists }),
  );
  assert.doesNotThrow(
    () => checkFullScanCheckpoint({ atsFull: false, args: [] }, { dataRoot: '/test-direction', exists }),
  );
  assert.doesNotThrow(() => checkFullScanCheckpoint({ atsFull: true, args: ['--dry-run'] }, { dataRoot: '/test-direction', exists }));
  assert.doesNotThrow(() => checkFullScanCheckpoint({ atsFull: true, args: ['--help'] }, { dataRoot: '/test-direction', exists }));
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
  assert.match(src, /if \(useRussianSources\(profile\)\)/);
  assert.match(src, /step\('source-registry\.mjs',/);
  assert.match(src, /CAREER_OPS_PORTALS: regionalPortals/);
});
