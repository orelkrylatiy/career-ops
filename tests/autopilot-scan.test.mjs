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
