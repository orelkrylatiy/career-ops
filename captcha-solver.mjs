#!/usr/bin/env node
// captcha-solver.mjs — vision-based text-CAPTCHA solver for live Playwright
// CLI sessions.
//
// Port of the hh-ops captcha flow (utils/opencode.py +
// apply_vacancies._solve_captcha_async) to the career-ops browser
// architecture. hh-ops had to sync cookies and proxies between a requests
// session and a separate Playwright browser; here the applier already works
// inside one named Playwright CLI session, so the solver drives that same
// session through `run-code` — no cookie/proxy sync is needed.
//
// Policy (AGENTS.md §5): a text-image CAPTCHA (warped words, Cyrillic
// phrases, short tokens) is a solvable step, not a stop. The solver only ever
// types the recognized answer into the site's own captcha input — no request
// tampering, no automation masking. Third-party interactive challenges
// (hCaptcha/reCAPTCHA/Turnstile) and OTP/2FA are detected and refused.
//
// Usage:
//   node captcha-solver.mjs detect [--session career-ops-worker-0] [--json]
//   node captcha-solver.mjs solve [--session S] [--flow apply] [--attempts 5]
//                                 [--image-selector CSS] [--input-selector CSS]
//                                 [--reload-on-fail] [--json]
//   node captcha-solver.mjs ocr <image.png> [--json]
//
// Solvers, in order:
//   1. OpenCode CLI vision model — env CAPTCHA_OPENCODE_COMMAND (default
//      `opencode`), CAPTCHA_OPENCODE_MODEL (comma list, default
//      `openai/gpt-6.1-sol,openai/gpt-5.6-sol`).
//   2. OpenAI-compatible vision API — OPENAI_API_KEY + OPENAI_BASE_URL,
//      model CAPTCHA_VISION_MODEL || OPENAI_MODEL.
//
// Artifacts per attempt (PNG + CURRENT.json pointer + result JSON):
//   data/autopilot/captcha/<profile>/<flow>/
//
// Exit codes: 0 = solved / detection ran; 1 = not solved (third-party
// challenge, OCR unavailable, attempts exhausted) or usage error.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const CAPTCHA_ROOT = path.join(DATA_ROOT, 'data', 'autopilot', 'captcha');
const DEFAULT_SESSION = process.env.AUTOPILOT_BROWSER_SESSION || 'career-ops-worker-0';

try {
  const { config } = await import('dotenv');
  config();
} catch { /* dotenv optional */ }

// ---------------------------------------------------------------------------
// Answer normalization — faithful port of hh-ops _normalize_captcha_text.
// ---------------------------------------------------------------------------

const MARKDOWN_FENCE_RE = /^```(?:text)?\s*|\s*```$/g;
const REFUSED_ANSWERS = new Set(['captcha', 'recaptcha']);

export function normalizeCaptchaText(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return '';

  raw = raw.replace(new RegExp(MARKDOWN_FENCE_RE.source, 'gi'), '').trim();

  // Legacy short-token behaviour, including model responses such as
  // "The answer is xY7kQ2": if the whole reply compacted to a 4-8 char
  // ASCII token, that token is the answer.
  const compact = raw.replace(/[^A-Za-z0-9]/g, '');
  if (compact.length >= 4 && compact.length <= 8) return compact;

  const tokens = raw.match(/[A-Za-z0-9]{4,8}/g);
  if (tokens && !/[А-Яа-яЁё]/.test(raw)) return tokens[tokens.length - 1];

  // Vision models sometimes wrap the answer in quotes or introduce it with a
  // short label ("Ответ: превет мир"). Prefer that payload before applying
  // conservative Unicode filtering.
  const quoted = [...raw.matchAll(/[«"']([^»"']+)[»"']/g)];
  let candidate = quoted.length ? quoted[quoted.length - 1][1] : raw;
  if (candidate.includes(':')) {
    const idx = candidate.lastIndexOf(':');
    const prefix = candidate.slice(0, idx);
    const payload = candidate.slice(idx + 1);
    if (/(капч|captcha|ответ|текст|изображени|написан)/i.test(prefix)) {
      candidate = payload;
    }
  }

  // Python's str.isalnum() is Unicode-aware; [\p{L}\p{N}] is its JS analogue.
  candidate = [...candidate]
    .map((ch) => (/[\p{L}\p{N} -]/u.test(ch) ? ch : ' '))
    .join('');
  candidate = candidate.replace(/\s+/g, ' ').trim().replace(/^[-\s]+|[-\s]+$/g, '');
  if (
    candidate.length >= 4 && candidate.length <= 64
    && candidate.split(' ').length <= 6
  ) {
    return candidate;
  }
  return '';
}

export function isRefusedAnswer(answer) {
  return REFUSED_ANSWERS.has(String(answer ?? '').trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Playwright CLI bridge — same pattern as autopilot-verify.mjs.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
let playwrightCliPath = null;

function localPlaywrightCliPath() {
  if (playwrightCliPath) return playwrightCliPath;
  const packageEntry = require.resolve('playwright');
  const candidate = path.join(path.dirname(packageEntry), 'cli.js');
  if (!existsSync(candidate)) {
    throw new Error(`Playwright CLI entrypoint not found beside ${packageEntry}`);
  }
  playwrightCliPath = candidate;
  return playwrightCliPath;
}

function safeSession(raw) {
  const value = String(raw || DEFAULT_SESSION).trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
    throw new Error('invalid Playwright CLI session name');
  }
  return value;
}

function runCli(session, args, { raw = false, timeout = 30_000, allowFailure = false } = {}) {
  const cli = localPlaywrightCliPath();
  const argv = ['cli', `-s=${safeSession(session)}`];
  if (raw) argv.push('--raw');
  argv.push(...args);
  const res = spawnSync(process.execPath, [cli, ...argv], {
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error && !allowFailure) throw res.error;
  if (res.status !== 0 && !allowFailure) {
    throw new Error(
      `playwright-cli ${args[0] || 'command'} failed: `
      + String(res.stderr || res.stdout || res.error?.message || res.status).trim().slice(0, 1200),
    );
  }
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  };
}

function parseJsonish(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty JSON result from Playwright CLI');
  const candidates = [raw];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    } catch { /* try next */ }
  }
  throw new Error(`could not parse Playwright CLI JSON result: ${raw.slice(0, 300)}`);
}

function runProbe(session, code, { timeout = 40_000 } = {}) {
  const run = () => runCli(session, ['run-code', code], { raw: true, timeout });
  // `run-code` intermittently returns empty output (same as the submit
  // verifier); retry once before giving up.
  let parsed = parseJsonish(run().stdout);
  if (!parsed || typeof parsed !== 'object' || (!parsed.pageUrl && !parsed.frames)) {
    parsed = parseJsonish(run().stdout);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Playwright probe returned non-object');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Detection — find a text-image captcha (or a third-party challenge) on any
// frame of the live page.
// ---------------------------------------------------------------------------

const CAPTCHA_IMAGE_SELECTORS = [
  'img[data-qa*="captcha" i]',
  'img[class*="captcha" i]',
  'img[id*="captcha" i]',
  'img[src*="captcha" i]',
  'img[alt*="captcha" i]',
  'img[alt*="код" i]',
];

const CAPTCHA_INPUT_SELECTORS = [
  'input[data-qa*="captcha" i]',
  'input[name*="captcha" i]',
  'input[id*="captcha" i]',
  'input[class*="captcha" i]',
  'input[placeholder*="captcha" i]',
  'input[placeholder*="капч" i]',
  'input[placeholder*="код" i]',
  'input[placeholder*="символ" i]',
  'input[aria-label*="captcha" i]',
  'input[aria-label*="капч" i]',
  'input[title*="капч" i]',
];

const THIRD_PARTY_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="reCAPTCHA" i]',
  'iframe[title*="hCaptcha" i]',
  'iframe[title*="Cloudflare security challenge" i]',
  '.g-recaptcha',
  '.h-captcha',
];

export function buildCaptchaProbeCode() {
  const payload = JSON.stringify({
    imageSelectors: CAPTCHA_IMAGE_SELECTORS,
    inputSelectors: CAPTCHA_INPUT_SELECTORS,
    thirdPartySelectors: THIRD_PARTY_SELECTORS,
  });
  return `async page => {
    const cfg = ${payload};
    const frames = [];
    const errors = [];
    for (const frame of page.frames()) {
      try {
        // Everything the browser callback needs must live INSIDE it: helper
        // closures from the outer run-code scope are not serialized into the
        // page context.
        const state = await frame.evaluate((cfg) => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
          };
          const firstMatch = (root, selectors) => {
            for (const sel of selectors) {
              try {
                const el = [...root.querySelectorAll(sel)].find(visible);
                if (el) return { sel, src: String(el.getAttribute('src') || el.getAttribute('alt') || '').slice(0, 200) };
              } catch { /* invalid selector on this engine — skip */ }
            }
            return null;
          };
          return {
            image: firstMatch(document, cfg.imageSelectors),
            input: firstMatch(document, cfg.inputSelectors),
            thirdParty: cfg.thirdPartySelectors
              .map((sel) => {
                try {
                  const el = [...document.querySelectorAll(sel)].find(visible);
                  return el ? sel : null;
                } catch { return null; }
              })
              .filter(Boolean),
          };
        }, cfg);
        if (state.image || state.input || (state.thirdParty && state.thirdParty.length)) {
          frames.push({ frameUrl: frame.url(), ...state });
        }
      } catch (err) {
        // A frame may detach while the SPA navigates; keep a capped trace for
        // diagnosis instead of failing the whole probe.
        if (errors.length < 5) errors.push({ frameUrl: frame.url(), error: String(err?.message || err).slice(0, 200) });
      }
    }
    return JSON.stringify({ pageUrl: page.url(), frames, errors });
  }`;
}

export function interpretProbe(probe) {
  const frames = Array.isArray(probe?.frames) ? probe.frames : [];
  const thirdParty = [...new Set(frames.flatMap((f) => f.thirdParty || []))];
  // A page can carry an invisible reCAPTCHA v3 scoring widget and still show a
  // plain text captcha as the actual gate — the text captcha wins whenever a
  // solvable pair exists. Prefer a frame that has both the image and the
  // input; fall back to any frame with the image.
  const paired = frames.find((f) => f.image && f.input);
  const withImage = paired || frames.find((f) => f.image);
  const withInput = paired || frames.find((f) => f.input);
  if (withImage && withInput) {
    return {
      kind: 'text_image',
      frameUrl: withImage.frameUrl,
      imageSelector: withImage.image.sel,
      imageHint: withImage.image.src || '',
      inputSelector: withInput.input.sel,
      inputHint: withInput.input.src || '',
      pageUrl: probe.pageUrl || '',
      thirdParty,
    };
  }
  if (thirdParty.length) {
    return {
      kind: 'third_party',
      frameUrl: frames[0]?.frameUrl || '',
      imageSelector: null,
      inputSelector: null,
      imageHint: '',
      inputHint: '',
      pageUrl: probe.pageUrl || '',
      thirdParty,
    };
  }
  return {
    kind: 'none',
    frameUrl: '',
    imageSelector: null,
    inputSelector: null,
    imageHint: '',
    inputHint: '',
    pageUrl: probe.pageUrl || '',
    thirdParty,
  };
}

// ---------------------------------------------------------------------------
// In-page steps: screenshot the captcha image, then fill + confirm.
// ---------------------------------------------------------------------------

export function buildCaptureCode({ frameUrl, imageSelector, artifactPath }) {
  return `async page => {
    const frameUrl = ${JSON.stringify(frameUrl)};
    const sel = ${JSON.stringify(imageSelector)};
    const out = ${JSON.stringify(artifactPath)};
    const frame = page.frames().find((f) => f.url() === frameUrl)
      || (frameUrl === page.mainFrame().url() ? page.mainFrame() : null);
    if (!frame) return JSON.stringify({ ok: false, reason: 'frame not found: ' + frameUrl });
    const el = frame.locator(sel).first();
    await el.waitFor({ state: 'visible', timeout: 20000 });
    // Do not screenshot a blank placeholder: HH-style challenges render the
    // <img> before the payload arrives.
    try {
      await frame.waitForFunction(
        (s) => {
          const img = document.querySelector(s);
          return img && img.complete && img.naturalWidth > 0;
        },
        sel,
        { timeout: 15000 },
      );
    } catch { return JSON.stringify({ ok: false, reason: 'captcha image never finished loading' }); }
    await el.screenshot({ path: out });
    return JSON.stringify({ ok: true, path: out });
  }`;
}

export function buildFillAndConfirmCode({ frameUrl, inputSelector, answer }) {
  return `async page => {
    const frameUrl = ${JSON.stringify(frameUrl)};
    const sel = ${JSON.stringify(inputSelector)};
    const answer = ${JSON.stringify(answer)};
    const frame = page.frames().find((f) => f.url() === frameUrl)
      || (frameUrl === page.mainFrame().url() ? page.mainFrame() : null);
    if (!frame) return JSON.stringify({ ok: false, reason: 'frame not found: ' + frameUrl });
    const input = frame.locator(sel).first();
    try {
      await input.waitFor({ state: 'visible', timeout: 15000 });
    } catch { return JSON.stringify({ ok: false, reason: 'captcha input not visible' }); }
    await input.fill(answer);
    await input.press('Enter');
    // networkidle never settles on busy portals; success = the captcha input
    // disappears from its frame.
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(2500);
      const still = await input.isVisible().catch(() => false);
      if (!still) return JSON.stringify({ ok: true, accepted: true });
    }
    return JSON.stringify({ ok: true, accepted: false });
  }`;
}

// ---------------------------------------------------------------------------
// Artifacts — hh-ops layout: <root>/<profile>/<flow>/ with a CURRENT.json
// pointer so a human (or another agent) can find the latest challenge fast.
// ---------------------------------------------------------------------------

function slugify(value, fallback) {
  const slug = String(value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || fallback;
}

export function makeCaptchaArtifactPath({ flow, attempt, profileId = 'default', root = CAPTCHA_ROOT } = {}) {
  const runDir = path.join(root, slugify(profileId, 'default'), slugify(flow, 'captcha'));
  mkdirSync(runDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return path.join(runDir, `captcha_${slugify(flow, 'captcha')}_${stamp}_attempt_${String(attempt).padStart(2, '0')}.png`);
}

function recordCaptchaCurrent(imagePath, { flow, attempt, profileId = 'default', root = CAPTCHA_ROOT } = {}) {
  const metadata = {
    flow,
    profile_id: profileId,
    attempt,
    image: path.resolve(imagePath),
    captured_at: new Date().toISOString(),
  };
  writeFileSync(path.join(path.dirname(imagePath), 'CURRENT.json'), JSON.stringify(metadata, null, 2), 'utf8');
  writeFileSync(path.join(root, 'CURRENT.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

export function saveCaptchaImage(imageBytes, opts = {}) {
  const imagePath = makeCaptchaArtifactPath(opts);
  writeFileSync(imagePath, imageBytes);
  recordCaptchaCurrent(imagePath, opts);
  return imagePath;
}

export function saveCaptchaAttemptResult(imagePath, { provider, answer, accepted = null } = {}) {
  const resultPath = imagePath.replace(/\.png$/i, '.json');
  writeFileSync(resultPath, JSON.stringify({
    image: path.resolve(imagePath),
    provider,
    answer,
    accepted,
    recorded_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  return resultPath;
}

// ---------------------------------------------------------------------------
// OCR tier 1 — OpenCode CLI vision model.
// ---------------------------------------------------------------------------

const OCR_PROMPT = [
  'Распознай текст на изображении капчи. Верни ТОЛЬКО текст с картинки:',
  'если это два искажённых русских слова — верни их кириллицей через пробел;',
  'если это короткий латинский/цифровой токен — верни его как есть, с учётом регистра.',
  'Без пояснений, кавычек и исправления смысла.',
].join(' ');

function resolveExecutable(name) {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')]
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext.toLowerCase()}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

function spawnCli(executable, args, { timeout } = {}) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  if (!needsShell) {
    return spawnSync(executable, args, { encoding: 'utf8', shell: false, timeout });
  }
  // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980), and
  // `shell: true` does no argument quoting on Windows — quote each argument
  // ourselves. None of our arguments (model id, artifact path, OCR prompt)
  // contain double quotes, so this is safe for the CLI parsers in practice.
  const quoted = args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
  return spawnSync(`"${executable}" ${quoted}`, {
    encoding: 'utf8',
    shell: true,
    timeout,
    windowsHide: true,
  });
}

export function ocrWithOpencode(imagePath, { timeoutMs } = {}) {
  const command = process.env.CAPTCHA_OPENCODE_COMMAND || 'opencode';
  const executable = resolveExecutable(command);
  if (!executable) throw new Error(`OpenCode executable not found: ${command}`);
  const models = (process.env.CAPTCHA_OPENCODE_MODEL || 'openai/gpt-6.1-sol,openai/gpt-5.6-sol')
    .split(',').map((m) => m.trim()).filter(Boolean);
  const timeout = timeoutMs ?? (Number(process.env.CAPTCHA_OPENCODE_TIMEOUT_MS) || 120_000);

  let lastError = null;
  for (const model of models) {
    const res = spawnCli(executable, ['run', '--model', model, '--file', path.resolve(imagePath), OCR_PROMPT], { timeout });
    if (res.error) { lastError = res.error; continue; }
    if (res.status !== 0) {
      lastError = new Error(`OpenCode (${model}) exited ${res.status}: ${String(res.stderr || res.stdout || '').trim().slice(0, 300)}`);
      continue;
    }
    return { provider: 'opencode', model, answer: String(res.stdout || '').trim() };
  }
  throw lastError || new Error('OpenCode produced no result');
}

// ---------------------------------------------------------------------------
// OCR tier 2 — OpenAI-compatible vision API.
// ---------------------------------------------------------------------------

export async function ocrWithVisionApi(imageBytes) {
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set — vision API fallback unavailable');
  const model = process.env.CAPTCHA_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const imageBase64 = Buffer.from(imageBytes).toString('base64');

  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: 'Ты должен распознать текст на изображении. Верни ТОЛЬКО текст, без каких-либо объяснений или дополнительных символов.',
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}`, detail: 'high' } },
          { type: 'text', text: OCR_PROMPT },
        ],
      },
    ],
    temperature: 0,
    // Reasoning models spend the token budget on thinking; leave headroom.
    max_tokens: Number(process.env.CAPTCHA_MAX_TOKENS) || 2048,
    stream: false,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`vision API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error('vision API returned no message');
  // Reasoning models (GLM etc.) may leave the answer in reasoning_content.
  return {
    provider: 'api',
    model,
    answer: String(message.content || message.reasoning_content || '').trim(),
  };
}

export async function ocrImageFile(imagePath) {
  const imageBytes = readFileSync(imagePath);
  if (!imageBytes.length) throw new Error(`empty image file: ${imagePath}`);
  let provider;
  let answer;
  try {
    ({ provider, answer } = ocrWithOpencode(imagePath));
  } catch (opencodeError) {
    ({ provider, answer } = await ocrWithVisionApi(imageBytes));
  }
  const normalized = normalizeCaptchaText(answer);
  return {
    provider,
    raw: answer,
    answer: normalized && !isRefusedAnswer(normalized) ? normalized : '',
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function emit(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  return result;
}

function reloadPage(session) {
  runCli(
    session,
    ['run-code', 'async page => { await page.reload({ waitUntil: "domcontentloaded" }); return "reloaded"; }'],
    { raw: true, timeout: 60_000, allowFailure: true },
  );
}

export async function cmdDetect({ session, json = false } = {}) {
  const probe = runProbe(safeSession(session), buildCaptchaProbeCode());
  const verdict = interpretProbe(probe);
  if (!json) {
    if (verdict.kind === 'text_image') {
      console.log(`captcha: text_image | image=${verdict.imageSelector} | input=${verdict.inputSelector}`);
    } else if (verdict.kind === 'third_party') {
      console.log(`captcha: third_party challenge — ${verdict.thirdParty.join(', ')}`);
    } else {
      console.log('captcha: not detected');
    }
  }
  return emit(verdict, json);
}

export async function cmdSolve({
  session,
  flow = 'apply',
  attempts = 5,
  profileId,
  imageSelector = null,
  inputSelector = null,
  reloadOnFail = false,
  json = false,
} = {}) {
  const s = safeSession(session);
  const profile = slugify(profileId || process.env.CAPTCHA_PROFILE_ID || process.env.AUTOPILOT_WORKER_ID || 'default', 'default');
  const maxAttempts = Math.max(1, Math.min(8, Number(attempts) || 5));
  const history = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let verdict;
    try {
      verdict = interpretProbe(runProbe(s, buildCaptchaProbeCode()));
    } catch (err) {
      history.push({ attempt, error: String(err?.message || err) });
      break;
    }

    if (verdict.kind === 'third_party') {
      return emit({
        solved: false, attempts: history.length, reason: 'third_party_challenge',
        thirdParty: verdict.thirdParty, pageUrl: verdict.pageUrl, history,
      }, json);
    }
    if (verdict.kind === 'none') {
      // After at least one submitted answer, "no captcha anymore" means the
      // site accepted the previous attempt.
      if (history.length) {
        return emit({ solved: true, attempts: history.length, reason: 'accepted', history }, json);
      }
      return emit({ solved: false, attempts: 0, reason: 'captcha_not_detected', pageUrl: verdict.pageUrl, history }, json);
    }

    const imgSel = imageSelector || verdict.imageSelector;
    const inSel = inputSelector || verdict.inputSelector;
    if (!imgSel || !inSel) {
      history.push({ attempt, error: 'captcha detected but image/input selector missing', kind: verdict.kind });
      break;
    }

    const imagePath = makeCaptchaArtifactPath({ flow, attempt, profileId: profile });
    let capture;
    try {
      capture = parseJsonish(runCli(
        s,
        ['run-code', buildCaptureCode({ frameUrl: verdict.frameUrl, imageSelector: imgSel, artifactPath: imagePath })],
        { raw: true, timeout: 60_000 },
      ).stdout);
    } catch (err) {
      history.push({ attempt, error: `capture failed: ${String(err?.message || err)}` });
      if (reloadOnFail) reloadPage(s);
      continue;
    }
    if (!capture.ok) {
      history.push({ attempt, error: capture.reason || 'capture failed' });
      if (reloadOnFail) reloadPage(s);
      continue;
    }
    recordCaptchaCurrent(imagePath, { flow, attempt, profileId: profile });

    let provider;
    let answer;
    try {
      ({ provider, answer } = await ocrImageFile(imagePath));
    } catch (ocrError) {
      history.push({
        attempt, error: `ocr unavailable: ${String(ocrError?.message || ocrError)}`,
        image: imagePath,
      });
      saveCaptchaAttemptResult(imagePath, { provider: 'none', answer: '' });
      break;
    }
    saveCaptchaAttemptResult(imagePath, { provider, answer });

    if (!answer) {
      history.push({
        attempt, provider, answer, accepted: false, image: imagePath,
        note: 'unrecognized or refused answer (captcha/recaptcha token)',
      });
      if (reloadOnFail) reloadPage(s);
      continue;
    }

    let confirmation;
    try {
      confirmation = parseJsonish(runCli(
        s,
        ['run-code', buildFillAndConfirmCode({ frameUrl: verdict.frameUrl, inputSelector: inSel, answer })],
        { raw: true, timeout: 90_000 },
      ).stdout);
    } catch (err) {
      history.push({ attempt, provider, answer, error: String(err?.message || err), image: imagePath });
      continue;
    }
    saveCaptchaAttemptResult(imagePath, { provider, answer, accepted: Boolean(confirmation?.accepted) });
    history.push({ attempt, provider, answer, accepted: Boolean(confirmation?.accepted), image: imagePath });

    if (confirmation?.ok && confirmation.accepted) {
      return emit({ solved: true, attempts: attempt, provider, answer, reason: 'accepted', history }, json);
    }
  }

  return emit({ solved: false, attempts: history.length, reason: 'attempts_exhausted', history }, json);
}

export async function cmdOcr(target, { json = false } = {}) {
  if (!target || !existsSync(target)) {
    throw new Error(`ocr needs an existing image file, got: ${target || '(none)'}`);
  }
  const result = await ocrImageFile(target);
  if (!json && result) console.log(`answer: ${result.answer || '(unrecognized)'}`);
  return emit(result, json);
}

// ---------------------------------------------------------------------------

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function usage() {
  console.log(`Usage:
  node captcha-solver.mjs detect [--session career-ops-worker-0] [--json]
  node captcha-solver.mjs solve [--session S] [--flow apply] [--attempts 5]
                                [--profile id] [--image-selector CSS]
                                [--input-selector CSS] [--reload-on-fail] [--json]
  node captcha-solver.mjs ocr <image.png> [--json]`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const json = argv.includes('--json');

  if (command === 'detect') {
    const verdict = await cmdDetect({ session: flagValue(argv, '--session'), json });
    if (!verdict) process.exitCode = 1;
    return;
  }

  if (command === 'solve') {
    const result = await cmdSolve({
      session: flagValue(argv, '--session'),
      flow: flagValue(argv, '--flow') || 'apply',
      attempts: Number(flagValue(argv, '--attempts')) || 5,
      profileId: flagValue(argv, '--profile'),
      imageSelector: flagValue(argv, '--image-selector') || null,
      inputSelector: flagValue(argv, '--input-selector') || null,
      reloadOnFail: argv.includes('--reload-on-fail'),
      json,
    });
    if (!json) {
      console.log(result.solved
        ? `captcha solved (provider=${result.provider}, attempts=${result.attempts})`
        : `captcha NOT solved (${result.reason})`);
    }
    if (!result.solved) process.exitCode = 1;
    return;
  }

  if (command === 'ocr') {
    const result = await cmdOcr(argv[1], { json });
    if (!result?.answer) process.exitCode = 1;
    return;
  }

  usage();
  throw new Error(`unknown command: ${command || '(none)'}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`captcha-solver: ${err?.message ?? err}`);
    process.exit(1);
  });
}
