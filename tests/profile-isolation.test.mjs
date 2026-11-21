import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertIsolatedAutopilotContext } from '../lib/profile-isolation.mjs';

const base = path.resolve('/virtual', 'candidate-store');
const registry = { profiles: [
  { id: 'alice', directions: [{ id: 'react' }, { id: 'vue' }] },
  { id: 'bob', directions: [{ id: 'react' }, { id: 'nextjs' }] },
] };

function context(person, direction, extra = {}) {
  const root = path.join(base, 'data', 'profiles', person, direction);
  return {
    dataRoot: root, storeRoot: base, registry, codeRoot: base,
    env: { CAREER_OPS_ROOT: root, AUTOPILOT_WORKER_ID: person + '-' + direction,
      AUTOPILOT_BROWSER_SESSION: 'career-ops-' + person + '-' + direction,
      AUTOPILOT_BROWSER_PROFILE: path.join(root, 'data', 'browser-profile'), ...extra },
  };
}

test('two people with the same React direction require separate identity and sessions', () => {
  assert.deepEqual(assertIsolatedAutopilotContext(context('alice', 'react')).person, 'alice');
  assert.deepEqual(assertIsolatedAutopilotContext(context('bob', 'react')).person, 'bob');
  assert.notEqual(context('alice', 'react').dataRoot, context('bob', 'react').dataRoot);
});

test('wrong candidate session, worker owner or root blocks application before browser', () => {
  assert.throws(() => assertIsolatedAutopilotContext(context('alice', 'react',
    { AUTOPILOT_BROWSER_SESSION: 'career-ops-bob-react' })), /browser session/);
  assert.throws(() => assertIsolatedAutopilotContext(context('alice', 'react',
    { AUTOPILOT_WORKER_ID: 'bob-react' })), /worker ID/);
  assert.throws(() => assertIsolatedAutopilotContext({
    ...context('alice', 'react'), dataRoot: path.join(base, 'different-root'),
  }), /does not match any registered/);
});

test('stale foreign CV/portals/SQLite/browser overrides are rejected', () => {
  const foreign = context('bob', 'react').dataRoot;
  for (const key of ['CAREER_OPS_PROFILE', 'CAREER_OPS_PORTALS',
    'CAREER_OPS_TRACKER', 'CAREER_OPS_AUTOPILOT_DB', 'AUTOPILOT_BROWSER_PROFILE']) {
    assert.throws(() => assertIsolatedAutopilotContext(context('alice', 'react', {
      [key]: path.join(foreign, 'data', 'bad'),
    })), new RegExp(key));
  }
});

test('selected direction may use private overrides within its own data root', () => {
  const c = context('alice', 'react');
  c.env.CAREER_OPS_PORTALS = path.join(c.dataRoot, 'portals.yml');
  assert.equal(assertIsolatedAutopilotContext(c).direction, 'react');
});

test('missing profile registry cannot silently treat a registered direction as legacy', () => {
  const c = context('alice', 'react');
  c.registry = null;
  assert.throws(() => assertIsolatedAutopilotContext(c), /registry unavailable/);
});

test('external browser store is accepted only for the selected candidate and direction', () => {
  const browserStore = path.resolve('/virtual', 'browser-store');
  for (const person of ['alice', 'bob']) {
    const opts = context(person, 'react', {
      CAREER_OPS_BROWSER_STORE_ROOT: browserStore,
      AUTOPILOT_BROWSER_PROFILE: path.join(browserStore, person, 'react'),
    });
    assert.equal(assertIsolatedAutopilotContext(opts).person, person);
  }
  const unsafe = context('alice', 'react', {
    CAREER_OPS_BROWSER_STORE_ROOT: browserStore,
    AUTOPILOT_BROWSER_PROFILE: path.join(browserStore, 'bob', 'react'),
  });
  assert.throws(() => assertIsolatedAutopilotContext(unsafe), /AUTOPILOT_BROWSER_PROFILE/);
});

test('managed direction fails closed when the persistent browser path is missing', () => {
  const selected = context('alice', 'react');
  delete selected.env.AUTOPILOT_BROWSER_PROFILE;
  assert.throws(() => assertIsolatedAutopilotContext(selected), /AUTOPILOT_BROWSER_PROFILE missing/);
});
