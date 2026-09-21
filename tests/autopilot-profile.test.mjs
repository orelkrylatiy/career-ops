import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeApplicationProfiles,
  resolveApplicationProfile,
  configuredProfileSummary,
} from '../autopilot-profile.mjs';

const profile = {
  autopilot: {
    profiles: {
      frontend: {
        label: 'Frontend / React',
        stack: ['react', 'typescript', 'next.js'],
        title_keywords: ['frontend', 'react', 'next.js'],
        resume_variants: ['react', 'nextjs'],
      },
      mobile: {
        label: 'React Native',
        stack: ['react native', 'expo', 'ios', 'android'],
        title_keywords: ['react native', 'mobile'],
        resume_variants: ['react-native'],
      },
    },
  },
};

test('normalizes configured application profiles', () => {
  const rows = normalizeApplicationProfiles(profile);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'frontend');
  assert.deepEqual(rows[1].resumeVariants, ['react-native']);
  assert.deepEqual(configuredProfileSummary(profile)[0].stack, ['react', 'typescript', 'next.js']);
});

test('explicit profile wins and is validated', () => {
  const row = resolveApplicationProfile({ profile, requested: 'mobile', title: 'Frontend Engineer' });
  assert.equal(row.id, 'mobile');
  assert.equal(row.matchedBy, 'explicit');
  assert.throws(
    () => resolveApplicationProfile({ profile, requested: 'backend' }),
    /unknown application profile/,
  );
});

test('resume variant is stronger than title overlap', () => {
  const row = resolveApplicationProfile({
    profile,
    resumeVariant: 'react-native',
    title: 'Frontend React Engineer',
  });
  assert.equal(row.id, 'mobile');
  assert.equal(row.matchedBy, 'resume');
});

test('title/stack keywords classify when no resume mapping exists', () => {
  const row = resolveApplicationProfile({
    profile,
    title: 'Senior Next.js Frontend Engineer',
  });
  assert.equal(row.id, 'frontend');
  assert.equal(row.matchedBy, 'title');
});

test('unmatched applications remain visible as unclassified', () => {
  const row = resolveApplicationProfile({ profile, title: 'Chief of Staff' });
  assert.equal(row.id, 'unclassified');
  assert.equal(row.matchedBy, 'fallback');
});
