#!/usr/bin/env node
// autopilot-browser.mjs — step-driven headless Chromium driver for the autopilot loop.
// The agent decides; this script executes ONE step per invocation and reports page state,
// so every decision is made on fresh observed facts (agent-style navigation).
//
// Usage:
//   node autopilot-browser.mjs open <url>                 # navigate + full state dump
//   node autopilot-browser.mjs step <step.json>           # one action, then state dump
//   node autopilot-browser.mjs state                      # re-dump state, no action
// Optional flag (any position): --insecure — ignore HTTPS cert errors. RU career sites
// often use the НУЦ Минцифры CA, which is not in Chromium's default trust store.
//
// step.json: { "action": "click"|"fill"|"select"|"check"|"press"|"wait"|"snapshot",
//              "locator": { "role"?, "name"?, "text"?, "label"?, "placeholder"?, "css"?, "nth"? },
//              "value"?: string }
//
// Persistent profile: data/browser-profile (cookies/sessions survive across steps and runs).
// State written to data/browser-state.json; screenshot to output/browser-state.png.
// Security: only http/https targets; localhost/loopback/private/reserved hosts are refused.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
// Parallel sessions of this project would fight over one Chromium profile and
// one state file. AUTOPILOT_TAG=<suffix> isolates a run: files get the suffix,
// only the tagged serve/client pair sees each other.
const TAG = (process.env.AUTOPILOT_TAG || '').replace(/[^a-z0-9_-]/gi, '');
const taged = (p) => TAG ? p.replace(/(\.(json|png))$/, `-${TAG}$1`) : p;
const PROFILE_DIR = resolve(DATA_ROOT, 'data', TAG ? `browser-profile-${TAG}` : 'browser-profile');
const STATE_FILE = taged(resolve(DATA_ROOT, 'data', 'browser-state.json'));
const SHOT_FILE = taged(resolve(DATA_ROOT, 'output', 'browser-state.png'));
const SERVE_FILE = taged(resolve(DATA_ROOT, 'data', 'browser-serve.json'));

// Browser pages are untrusted input. Block loopback/private/link-local/CGNAT
// destinations after DNS resolution, not only literal hostnames. A hostname
// that resolves to 127.0.0.1 is just as dangerous as writing 127.0.0.1.
const BLOCKED_IPS = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15],
]) BLOCKED_IPS.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
]) BLOCKED_IPS.addSubnet(network, prefix, 'ipv6');
const BLOCKED_HOSTS = new Set([
  'localhost', 'metadata.google.internal', 'metadata.azure.websites', '169.254.169.254', '100.100.100.200',
]);
const HOST_SAFETY_CACHE = new Map();

export function isBlockedIp(address, family) {
  const type = family === 6 || String(address).includes(':') ? 'ipv6' : 'ipv4';
  try { return BLOCKED_IPS.check(String(address), type); } catch { return true; }
}

async function assertPublicHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host)) throw new Error(`refusing non-public host: ${hostname}`);
  if (HOST_SAFETY_CACHE.has(host)) return HOST_SAFETY_CACHE.get(host);
  const check = (async () => {
    const rows = await lookup(host, { all: true, verbatim: true });
    if (!rows.length) throw new Error(`hostname did not resolve: ${host}`);
    const blocked = rows.find(row => isBlockedIp(row.address, row.family));
    if (blocked) throw new Error(`refusing host ${host}: resolves to non-public ${blocked.address}`);
    return true;
  })();
  HOST_SAFETY_CACHE.set(host, check);
  try { return await check; } catch (err) { HOST_SAFETY_CACHE.delete(host); throw err; }
}

export async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`invalid URL: ${raw}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`only http/https is allowed, got ${u.protocol}`);
  }
  await assertPublicHost(u.hostname);
  return u.href;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve an upload only from the user data root and reject symlink escapes. */
export function resolveUploadPath(raw) {
  const lexical = path.isAbsolute(String(raw ?? '')) ? resolve(String(raw)) : resolve(DATA_ROOT, String(raw ?? ''));
  if (!existsSync(lexical)) throw new Error(`upload file does not exist: ${lexical}`);
  const real = realpathSync(lexical);
  if (!statSync(real).isFile()) throw new Error(`upload path is not a file: ${real}`);
  const roots = [resolve(DATA_ROOT, 'output'), resolve(DATA_ROOT, 'data')].map(root => {
    try { return realpathSync(root); } catch { return root; }
  });
  if (!roots.some(root => isInside(root, real))) {
    throw new Error(`upload path must resolve under ${roots.join(' or ')}; got ${real}`);
  }
  return real;
}

async function buildLocator(page, loc) {
  if (!loc || typeof loc !== 'object') throw new Error('step.locator required for this action');
  const scope = loc.frame ? page.frameLocator(loc.frame) : page;
  let l;
  if (loc.xpath) l = scope.locator(`xpath=${loc.xpath}`);
  else if (loc.css) l = loc.text ? scope.locator(loc.css).filter({ hasText: loc.text }) : scope.locator(loc.css);
  else if (loc.role) l = scope.getByRole(loc.role, loc.name ? { name: loc.name } : undefined);
  else if (loc.label) l = scope.getByLabel(loc.label);
  else if (loc.placeholder) l = scope.getByPlaceholder(loc.placeholder);
  else if (loc.text) l = scope.getByText(loc.text);
  else throw new Error('locator needs one of: css, role(+name), label, placeholder, text');
  if (typeof loc.nth === 'number') l = l.nth(loc.nth);
  // SPAs re-render constantly (hydration, polling, accordion swaps): a single
  // count() snapshot often lands mid-patch when the node is detached. Retry —
  // Playwright actions already wait for the element, this check is only a
  // guard against silent no-ops.
  let count = 0;
  for (let i = 0; i < 5; i++) {
    count = await l.count();
    if (count > 0) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (count === 0) throw new Error('locator matched 0 elements');
  if (count > 1 && typeof loc.nth !== 'number') {
    throw new Error(`locator matched ${count} elements; add nth or tighten scope`);
  }
  return l;
}

/**
 * Console/page-error/failed-request ring buffer — the page's own diagnostics
 * travel with every state dump, so a blank SPA render is explainable from
 * data/browser-state.json alone (what failed, at which URL, with which status).
 */
function attachConsoleTap(page) {
  const tail = [];
  const push = (kind, text) => {
    tail.push(`${new Date().toISOString().slice(11, 23)} ${kind}: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
    if (tail.length > 30) tail.shift();
  };
  page.on('console', (m) => push(m.type(), m.text()));
  page.on('pageerror', (e) => push('pageerror', e.message));
  page.on('requestfailed', (r) => push('requestfailed', `${r.method()} ${r.url()} :: ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => { if (r.status() >= 400) push(`http${r.status()}`, r.url()); });
  return tail;
}

async function dumpState(page, consoleTail = []) {
  const state = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const nameOf = (el) => {
      const lab = document.querySelector(`label[for="${el.id}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim().slice(0, 80);
      const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id;
      return aria ? String(aria).slice(0, 80) : '';
    };
    const fields = [...document.querySelectorAll('input, textarea, select')]
      .filter(vis)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        name: nameOf(el),
        id: el.id || '',
        attrName: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        value: el.type === 'password' ? '***' : String(el.value || '').slice(0, 120),
        required: el.required === true,
      }));
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .filter(vis)
      .map((el) => (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80))
      .filter(Boolean);
    const links = [...document.querySelectorAll('a[href]')]
      .filter(vis)
      .map((el) => ({ text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80), href: el.href.slice(0, 160) }))
      .filter((x) => x.text)
      .slice(0, 60);
    const headings = [...document.querySelectorAll('h1, h2, h3')]
      .filter(vis)
      .map((el) => el.textContent.trim().replace(/\s+/g, ' ').slice(0, 100))
      .filter(Boolean);
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')].filter(vis).length;
    const bodyText = document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200);
    return { fields, buttons, links, headings, dialogs, bodyText };
  }).catch((e) => ({ evalError: e.message }));

  // Same-process iframes (Personio-style embeds): collect their form fields so
  // the agent can see and fill them via { frame: <url-substring> } locators.
  const frameFields = [];
  for (const f of page.frames().filter((x) => x !== page.mainFrame()).slice(0, 5)) {
    try {
      const ff = await f.evaluate(() => {
        const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        return [...document.querySelectorAll('input, textarea, select')].filter(vis).map((el) => ({
          tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '',
          attrName: el.getAttribute('name') || '', id: el.id || '',
          placeholder: el.getAttribute('placeholder') || '', ariaLabel: el.getAttribute('aria-label') || '',
          value: el.type === 'password' ? '***' : String(el.value || '').slice(0, 120),
          required: el.required === true,
        }));
      });
      frameFields.push(...ff.map((x) => ({ ...x, frame: f.url().slice(0, 140) })));
    } catch { /* cross-origin frame — skip */ }
  }

  const result = {
    url: page.url(),
    title: await page.title(),
    dumpedAt: new Date().toISOString(),
    consoleTail,
    frameFields,
    ...state,
  };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(result, null, 2));
  mkdirSync(dirname(SHOT_FILE), { recursive: true });
  await page.screenshot({ path: SHOT_FILE, fullPage: false }).catch(() => {});
  return result;
}

async function launchContext(insecure, headed, noproxy = false) {
  // profi-worker pattern: a REAL browser with a window and a persistent
  // profile inside the project (data/browser-profile) is the default-grade
  // apply channel — headless is the fallback for scheduled/VPS runs.
  // Real Chrome (channel 'chrome') has an authentic fingerprint; if it is not
  // installed, fall back to the bundled Chromium, still with a window.
  // v2ray-style system proxies (HKCU ProxyEnable socks=127.0.0.1:10808) are
  // picked up by Chromium even with --no-proxy-server alone; and Playwright's
  // `proxy:{server:'direct://'}` option collapses into a broken
  // `--proxy-server=http://direct`. The raw Chromium flag works.
  const proxyArgs = noproxy ? ['--proxy-server=direct://', '--no-proxy-server'] : [];
  const baseOpts = {
    headless: false,
    viewport: null, // real window size, no fake viewport
    ignoreHTTPSErrors: insecure,
    args: proxyArgs,
  };
  let ctx;
  if (headed === false) {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: insecure,
      // Stealth: ATS boards (Ashby observed 2026-09-17) flag naive headless
      // submits as spam. Mask the automation surface.
      args: ['--disable-blink-features=AutomationControlled', ...proxyArgs],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] });
      window.chrome = window.chrome || { runtime: {} };
    });
  } else {
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...baseOpts, channel: 'chrome' });
    } catch (e) {
      console.error(`[autopilot-browser] real Chrome unavailable (${e.message.split('\n')[0]}) — falling back to bundled Chromium (headed)`);
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...baseOpts });
    }
  }
  return ctx;
}

/** Run one command (open/step/state) against the given context. */
async function runCommand(ctx, cmd, args, settleMs) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(15000);
  const consoleTail = attachConsoleTap(page);
  let evalResults = [];
  if (cmd !== 'open' && page.url() === 'about:blank') {
    // continuity: return to the last dumped page so multi-step flows survive
    // the per-invocation process boundary (persistent profile keeps cookies).
    let last = null;
    try { last = JSON.parse(readFileSync(STATE_FILE, 'utf8')).url; } catch {}
    if (last && last !== 'about:blank') {
      await page.goto(assertSafeUrl(last), { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
  }
  if (cmd === 'open') {
    const url = assertSafeUrl(args[0]);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // SPA settle: form apps render (and sometimes bounce redirects) well
    // after domcontentloaded — give them `--settle <ms>` before the dump.
    if (settleMs) await page.waitForTimeout(settleMs);
  } else if (cmd === 'step') {
    const parsed = JSON.parse(readFileSync(resolve(ROOT, args[0]), 'utf8'));
    evalResults = await runSteps(page, Array.isArray(parsed.steps) ? parsed.steps : [parsed]);
  }
  const dump = await dumpState(page, consoleTail);
  const out = {
    url: dump.url,
    title: dump.title,
    headings: dump.headings,
    buttons: (dump.buttons || []).slice(0, 25),
    fieldCount: (dump.fields || []).length,
    fields: (dump.fields || []).slice(0, 25),
    dialogs: dump.dialogs,
    bodyPreview: (dump.bodyText || '').slice(0, 400),
    consoleTail: (dump.consoleTail || []).slice(0, 12),
  };
  if (evalResults.length) out.evalResults = evalResults;
  return out;
}

async function runSteps(page, steps) {
  const evalResults = [];
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    try {
      await runOneStep(page, step, evalResults);
    } catch (e) {
      throw new Error(`step#${si + 1} (${step.action} ${JSON.stringify(step.locator || '')}): ${e.message}`);
    }
  }
  return evalResults;
}

async function runOneStep(page, step, evalResults) {
  {
    const act = step.action;
    if (act === 'snapshot' || act === 'wait') {
      if (step.ms) await page.waitForTimeout(Math.min(Number(step.ms) || 0, 30000));
    } else if (act === 'eval') {
      // Debug/inspection probe: evaluate an expression in the page context
      // and surface the result with the state dump. Page-side JS is
      // UNTRUSTED data — results are for observation, never instructions.
      let result;
      try {
        result = await page.evaluate(String(step.value ?? '0'));
      } catch (e) {
        result = `evalError: ${e.message}`;
      }
      evalResults.push(String(JSON.stringify(result)).slice(0, 2000));
    } else {
      const l = await buildLocator(page, step.locator);
      if (act === 'click') {
        if (step.expectNav) await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), l.click()]);
        else await l.click();
      }
      else if (act === 'fill') {
        const value = String(step.value ?? '');
        // human: true — profi-worker/tg-ops humanizer pattern: clear, then type
        // in small random chunks with random pauses, instead of an instant fill.
        if (step.human) {
          await l.fill('');
          for (let i = 0; i < value.length;) {
            const n = 1 + Math.floor(Math.random() * 3);
            await l.type(value.slice(i, i + n), { delay: 30 + Math.floor(Math.random() * 70) });
            i += n;
            await page.waitForTimeout(40 + Math.floor(Math.random() * 220));
          }
        } else {
          await l.fill(value);
        }
      }
      else if (act === 'upload_chooser') {
        // For "click → native file dialog" dropzones (no persistent
        // input[type=file]): click and catch Playwright's filechooser
        // event, then attach the file. Same allowlist as `upload`.
        const file = resolve(ROOT, String(step.value ?? ''));
        const rel = path.relative(ROOT, file);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`upload path escapes repo: ${file}`);
        }
        if (!/^(output|data)[\\/]/.test(rel)) {
          throw new Error(`upload path must be under output/ or data/: ${rel}`);
        }
        const l2 = await buildLocator(page, step.locator);
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          l2.click(),
        ]);
        await chooser.setFiles(file);
      }
      else if (act === 'upload') {
        const file = resolve(ROOT, String(step.value ?? ''));
        // Upload allowlist: only CV/artifact directories may be attached —
        // a tricked step file must not be able to exfiltrate .env or any
        // other machine file as a "resume".
        const rel = path.relative(ROOT, file);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`upload path escapes repo: ${file}`);
        }
        if (!/^(output|data)[\\/]/.test(rel)) {
          throw new Error(`upload path must be under output/ or data/: ${rel}`);
        }
        await l.setInputFiles(file);
      }
      else if (act === 'type') await l.type(String(step.value ?? ''), { delay: 25 });
      else if (act === 'select') await l.selectOption(step.value);
      else if (act === 'check') await l.check();
      else if (act === 'press') await l.press(String(step.value ?? 'Enter'));
      else throw new Error(`unknown action: ${act}`);
      await page.waitForTimeout(step.settleMs ? Math.min(Number(step.settleMs), 10000) : 600);
    }
  }
  return evalResults;
}

/**
 * serve mode: one long-lived browser process + a loopback-only HTTP channel.
 * SPA state (uploads, multi-page wizard steps) survives between commands,
 * unlike the one-shot mode where every invocation reloads the page.
 * Client commands (open/step/state) transparently POST here when the server
 * is up; the one-shot path below is the fallback.
 */
async function serve(insecure, headed, noproxy) {
  const ctx = await launchContext(insecure, headed, noproxy);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/cmd') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { cmd, args = [], settleMs = 0 } = JSON.parse(body);
        if (!['open', 'step', 'state'].includes(cmd)) throw new Error(`unknown cmd: ${cmd}`);
        if (cmd === 'open' && (!args[0] || typeof args[0] !== 'string')) throw new Error('open needs a url');
        const state = await runCommand(ctx, cmd, args, settleMs);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...state }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  mkdirSync(dirname(SERVE_FILE), { recursive: true });
  writeFileSync(SERVE_FILE, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  console.error(`[autopilot-browser] serve: listening on 127.0.0.1:${port} (pid ${process.pid}); stop with: node autopilot-browser.mjs stop`);
  const shutdown = () => {
    try { rmSync(SERVE_FILE); } catch {}
    ctx.close().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Auto-shutdown watchdog: if no command arrives for 30 min, release the
  // browser (a forgotten serve process must not linger with logged-in forms).
  let watchdog = setTimeout(shutdown, 30 * 60 * 1000);
  server.on('request', () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(shutdown, 30 * 60 * 1000);
  });
}

/** POST the command to the serve process if one is alive; else null. */
async function tryServeClient(payload) {
  let port = 0;
  try { port = JSON.parse(readFileSync(SERVE_FILE, 'utf8')).port; } catch { return null; }
  const res = await fetch(`http://127.0.0.1:${port}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  }).catch(() => null);
  // A JSON response — even ok:false — means the serve is ALIVE and already
  // ran (or refused) the command; surface its error instead of re-running
  // one-shot against a profile the serve's browser still locks.
  if (!res) return null;
  const body = await res.json().catch(() => null);
  if (!body || typeof body.ok !== 'boolean') return null;
  return body;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  // --settle <ms> consumes its value, so both tokens are dropped from argv.
  const settleIdx = rawArgs.indexOf('--settle');
  const argv = rawArgs.filter((a, i) =>
    a !== '--insecure' && a !== '--headed' && a !== '--settle' &&
    !(settleIdx !== -1 && i === settleIdx + 1));
  const insecure = rawArgs.includes('--insecure');
  const headed = !rawArgs.includes("--headless");
  const noproxy = rawArgs.includes('--noproxy');
  const settleMs = (() => {
    const v = settleIdx !== -1 ? Number(rawArgs[settleIdx + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? Math.min(v, 30000) : 0;
  })();
  const [cmd, ...args] = argv;
  if (!cmd || !['open', 'step', 'state', 'serve', 'stop'].includes(cmd)) {
    console.error('usage: node autopilot-browser.mjs open <url> | step <step.json> | state | serve [--insecure] [--headed] | stop');
    process.exit(2);
  }
  if (cmd === 'serve') { await serve(insecure, headed, noproxy); return; }
  if (cmd === 'stop') {
    try {
      const { pid } = JSON.parse(readFileSync(SERVE_FILE, 'utf8'));
      process.kill(pid);
      rmSync(SERVE_FILE);
      console.log(`stopped serve pid ${pid}`);
    } catch { console.log('no serve process'); }
    return;
  }
  // Prefer the live serve process (page state survives); fall back to one-shot.
  const served = await tryServeClient({ cmd, args, settleMs });
  if (served) {
    if (!served.ok) {
      console.error(`[autopilot-browser] ${served.error}`);
      process.exit(1);
    }
    console.log(JSON.stringify(served, null, 2));
    console.error(`full state: ${STATE_FILE}\nscreenshot: ${SHOT_FILE}\n(serve mode: page was NOT reloaded)`);
    return;
  }
  const ctx = await launchContext(insecure, headed, noproxy);
  try {
    const out = await runCommand(ctx, cmd, args, settleMs);
    console.log(JSON.stringify(out, null, 2));
    console.error(`full state: ${STATE_FILE}\nscreenshot: ${SHOT_FILE}`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error(`[autopilot-browser] ${e.message}`); process.exit(1); });
