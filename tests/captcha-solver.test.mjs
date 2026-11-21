import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeCaptchaText,
  isRefusedAnswer,
  buildCaptchaProbeCode,
  buildCaptureCode,
  buildFillAndConfirmCode,
  interpretProbe,
  saveCaptchaImage,
  saveCaptchaAttemptResult,
  makeCaptchaArtifactPath,
} from '../captcha-solver.mjs';

test('normalizeCaptchaText passes short ASCII tokens through', () => {
  assert.equal(normalizeCaptchaText('xY7kQ2'), 'xY7kQ2');
  // Legacy hh behaviour: the answer inside a sentence is the last 4-8 token.
  assert.equal(normalizeCaptchaText('The answer is xY7kQ2'), 'xY7kQ2');
  assert.equal(normalizeCaptchaText('the captcha text reads kQ7zW2 now'), 'kQ7zW2');
});

test('normalizeCaptchaText preserves cyrillic phrases with spaces', () => {
  assert.equal(normalizeCaptchaText('привет мир'), 'привет мир');
  // A long cyrillic phrase must NOT collapse into the ASCII compact-token path.
  assert.equal(normalizeCaptchaText('синий трактор едет'), 'синий трактор едет');
});

test('normalizeCaptchaText strips markdown fences, quotes and labels', () => {
  assert.equal(normalizeCaptchaText('```\nпривет мир\n```'), 'привет мир');
  assert.equal(normalizeCaptchaText('«привет мир»'), 'привет мир');
  assert.equal(normalizeCaptchaText('Ответ: привет мир'), 'привет мир');
  assert.equal(normalizeCaptchaText('Текст на изображении: превет мир'), 'превет мир');
});

test('normalizeCaptchaText rejects noise and keeps unknown things empty', () => {
  assert.equal(normalizeCaptchaText(''), '');
  assert.equal(normalizeCaptchaText(null), '');
  assert.equal(normalizeCaptchaText('abc'), ''); // too short
  // > 6 words or > 64 chars is not a captcha answer.
  assert.equal(normalizeCaptchaText('один два три четыре пять шесть семь'), '');
});

test('refused answers are detected case-insensitively', () => {
  assert.equal(isRefusedAnswer('Captcha'), true);
  assert.equal(isRefusedAnswer('reCAPTCHA'), true);
  assert.equal(isRefusedAnswer('превет мир'), false);
  assert.equal(isRefusedAnswer(''), false);
});

test('probe code embeds captcha selectors for all three classes', () => {
  const code = buildCaptchaProbeCode();
  assert.match(code, /img\[data-qa\*=/);
  assert.match(code, /капч/);
  assert.match(code, /hcaptcha\.com/);
  assert.match(code, /challenges\.cloudflare\.com/);
  // The probe must scan every frame, not just the main one.
  assert.match(code, /page\.frames\(\)/);
});

test('capture code waits for the real image payload before screenshotting', () => {
  const code = buildCaptureCode({
    frameUrl: 'https://example.com/captcha',
    imageSelector: 'img[data-qa="captcha-picture"]',
    artifactPath: '/tmp/captcha.png',
  });
  assert.match(code, /naturalWidth > 0/);
  assert.match(code, /screenshot\(\{ path:/);
  assert.match(code, /example\.com\/captcha/);
});

test('fill code polls for input disappearance instead of networkidle', () => {
  const code = buildFillAndConfirmCode({
    frameUrl: 'https://example.com/',
    inputSelector: 'input[name="captcha"]',
    answer: 'превет мир',
  });
  assert.match(code, /input\.fill\(answer\)/);
  assert.match(code, /input\.press\('Enter'\)/);
  assert.match(code, /isVisible/);
  // The answer travels as a JSON literal, not via string interpolation.
  assert.match(code, /"превет мир"/);
});

test('interpretProbe prefers a same-frame image+input pair over lone third-party widgets', () => {
  const verdict = interpretProbe({
    pageUrl: 'https://example.com/apply',
    frames: [{
      frameUrl: 'https://example.com/apply',
      image: { sel: 'img[src*="captcha"]', src: '/captcha.png' },
      input: { sel: 'input[name="captcha"]', src: '' },
      thirdParty: ['[data-sitekey]'], // invisible v3 scorer must not win
    }],
  });
  assert.equal(verdict.kind, 'text_image');
  assert.equal(verdict.imageSelector, 'img[src*="captcha"]');
  assert.equal(verdict.inputSelector, 'input[name="captcha"]');
});

test('interpretProbe reports third-party challenges when no text captcha exists', () => {
  const verdict = interpretProbe({
    pageUrl: 'https://example.com/apply',
    frames: [{
      frameUrl: 'https://example.com/apply',
      image: null,
      input: null,
      thirdParty: ['iframe[src*="hcaptcha.com"]'],
    }],
  });
  assert.equal(verdict.kind, 'third_party');
  assert.deepEqual(verdict.thirdParty, ['iframe[src*="hcaptcha.com"]']);
});

test('interpretProbe returns none for a clean page', () => {
  const verdict = interpretProbe({ pageUrl: 'https://example.com/', frames: [] });
  assert.equal(verdict.kind, 'none');
});

test('artifacts follow the hh-ops layout with CURRENT.json pointers', () => {
  const root = mkdtempSync(join(tmpdir(), 'captcha-solver-test-'));
  const imagePath = saveCaptchaImage(Buffer.from('png-bytes'), {
    flow: 'apply',
    attempt: 2,
    profileId: 'worker/test',
    root,
  });
  assert.equal(readFileSync(imagePath, 'utf8'), 'png-bytes');
  assert.ok(imagePath.includes(join('worker_test', 'apply')));
  assert.match(imagePath, /captcha_apply_.*_attempt_02\.png$/);

  const current = JSON.parse(readFileSync(join(root, 'CURRENT.json'), 'utf8'));
  assert.equal(current.flow, 'apply');
  assert.equal(current.attempt, 2);
  assert.equal(current.profile_id, 'worker/test');
  assert.equal(current.image, imagePath);
  assert.ok(existsSync(join(root, 'worker_test', 'apply', 'CURRENT.json')));

  const resultPath = saveCaptchaAttemptResult(imagePath, {
    provider: 'opencode', answer: 'превет мир', accepted: true,
  });
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.provider, 'opencode');
  assert.equal(result.answer, 'превет мир');
  assert.equal(result.accepted, true);
});

test('makeCaptchaArtifactPath creates the run directory but no file', () => {
  const root = mkdtempSync(join(tmpdir(), 'captcha-solver-test-'));
  const p = makeCaptchaArtifactPath({ flow: 'registration', attempt: 1, profileId: 'default', root });
  assert.match(p, /captcha_registration_.*_attempt_01\.png$/);
  assert.ok(!existsSync(p));
});

test('odd profile ids and flows are sanitized like the hh-ops layout does', () => {
  const root = mkdtempSync(join(tmpdir(), 'captcha-solver-test-'));
  const p = makeCaptchaArtifactPath({ flow: 'apply!!', attempt: 1, profileId: '??', root });
  assert.ok(p.includes(join('default', 'apply')));
});
