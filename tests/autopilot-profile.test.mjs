import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredProfiles, resolveApplicationProfile } from '../autopilot-profile.mjs';

const profile = {
  autopilot: {
    profiles: {
      frontend: {
        label: 'Frontend',
        stack: ['react', 'typescript'],
        title_keywords: ['frontend'],
        resume_variants: ['react'],
      },
      mobile: {
        label: 'Mobile',
        stack: ['react native', 'ios', 'android'],
        title_keywords: ['mobile'],
        resume_variants: ['react-native'],
      },
    },
  },
};

test('configuredProfiles normalizes map entries', () => {
  const rows = configuredProfiles(profile);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, 'frontend');
  assert.deepEqual(rows[0].stack, ['react', 'typescript']);
});

test('explicit application profile wins', () => {
  const out = resolveApplicationProfile({
    job: { title: 'Frontend Engineer' },
    profile,
    explicitProfile: 'mobile',
    resumeVariant: 'react',
  });
  assert.equal(out.key, 'mobile');
  assert.equal(out.reason, 'explicit');
});

test('resume variant is strongest automatic profile signal', () => {
  const out = resolveApplicationProfile({
    job: { title: 'React Native Mobile Engineer' },
    profile,
    resumeVariant: 'react-native',
  });
  assert.equal(out.key, 'mobile');
});

test('title and stack keywords classify when resume variant is absent', () => {
  const out = resolveApplicationProfile({
    job: { title: 'Senior Frontend React Engineer' },
    profile,
  });
  assert.equal(out.key, 'frontend');
});

test('unknown explicit profile is rejected when profiles are configured', () => {
  assert.throws(
    () => resolveApplicationProfile({ job: {}, profile, explicitProfile: 'backend' }),
    /unknown autopilot profile/,
  );
});
