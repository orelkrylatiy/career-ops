import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(path.join(tmpdir(), 'career-ops-resume-test-'));
process.env.CAREER_OPS_ROOT = ROOT;
mkdirSync(path.join(ROOT, 'output', 'resumes'), { recursive: true });
for (const name of ['rn.pdf', 'next.pdf', 'react.pdf', 'general.pdf']) {
  writeFileSync(path.join(ROOT, 'output', 'resumes', name), 'fixture');
}

const modUrl = pathToFileURL(path.resolve('autopilot-resume.mjs')).href + '?test=' + Date.now();
const { resolveResume, scoreResumeVariant } = await import(modUrl);

const profile = {
  autopilot: {
    cv_pdf: 'output/resumes/general.pdf',
    resumes: {
      prefer_generated: true,
      fallback: 'general',
      variants: {
        'react-native': {
          file: 'output/resumes/rn.pdf',
          title_keywords: ['react native', 'mobile'],
          keywords: ['react native', 'expo', 'ios', 'android'],
          priority: 30,
        },
        nextjs: {
          file: 'output/resumes/next.pdf',
          title_keywords: ['next.js', 'nextjs'],
          keywords: ['next.js', 'app router', 'server components'],
          priority: 20,
        },
        react: {
          file: 'output/resumes/react.pdf',
          title_keywords: ['frontend', 'react'],
          keywords: ['react', 'typescript', 'javascript'],
          priority: 10,
        },
        general: {
          file: 'output/resumes/general.pdf',
          keywords: [],
        },
      },
    },
  },
};

test('title matches carry more weight than body matches', () => {
  const rn = scoreResumeVariant(profile.autopilot.resumes.variants['react-native'], 'Senior Mobile Engineer', 'typescript react');
  const react = scoreResumeVariant(profile.autopilot.resumes.variants.react, 'Senior Mobile Engineer', 'typescript react');
  assert.ok(rn.score > react.score);
});

test('selects React Native variant from title and JD', () => {
  const result = resolveResume({ profile, title: 'Senior React Native Engineer', description: 'Expo, iOS and Android' });
  assert.equal(result.ok, true);
  assert.equal(result.variant, 'react-native');
  assert.equal(result.path, 'output/resumes/rn.pdf');
});

test('explicit ready variant overrides routing', () => {
  const result = resolveResume({ profile, title: 'React Native Engineer', explicitVariant: 'nextjs' });
  assert.equal(result.variant, 'nextjs');
  assert.equal(result.source, 'explicit');
});

test('existing generated tailored PDF wins when enabled', () => {
  mkdirSync(path.join(ROOT, 'output', 'tailored'), { recursive: true });
  writeFileSync(path.join(ROOT, 'output', 'tailored', 'acme.pdf'), 'tailored');
  const result = resolveResume({
    profile,
    title: 'React Native Engineer',
    generatedPath: 'output/tailored/acme.pdf',
  });
  assert.equal(result.variant, 'tailored');
  assert.equal(result.source, 'generated');
});

test('missing generated PDF falls back to the matched prepared resume', () => {
  const result = resolveResume({
    profile,
    title: 'Next.js Engineer',
    description: 'App Router and server components',
    generatedPath: 'output/tailored/missing.pdf',
  });
  assert.equal(result.ok, true);
  assert.equal(result.variant, 'nextjs');
  assert.equal(result.source, 'generated_fallback_match');
});

test('no match falls back to configured general resume', () => {
  const result = resolveResume({ profile, title: 'Engineering Manager', description: 'people leadership' });
  assert.equal(result.variant, 'general');
  assert.equal(result.source, 'fallback');
});

test('legacy cv_pdf remains the final compatibility fallback', () => {
  const legacyProfile = { autopilot: { cv_pdf: 'output/resumes/general.pdf' } };
  const result = resolveResume({ profile: legacyProfile, title: 'Anything' });
  assert.equal(result.variant, 'legacy-default');
  assert.equal(result.source, 'legacy');
});

test('resume paths cannot escape output/data roots', () => {
  const bad = structuredClone(profile);
  bad.autopilot.resumes.variants.react.file = '../secret.pdf';
  const result = resolveResume({ profile: bad, explicitVariant: 'react' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'variant_file_missing');
});

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
