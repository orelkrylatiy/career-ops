#!/usr/bin/env node
// notify-tg.mjs — Telegram notifier for the autopilot.
//
// SECURITY (hard rule): the ONLY host this script may ever contact is the
// literal https://api.telegram.org — pinned as a module constant and verified
// against the URL object after construction. The request URL is built solely
// from that constant plus the env-var token; text/message content (which can
// come from untrusted job-posting data) is sent only inside the JSON body of
// the POST, never interpolated into any URL. There is no code path that feeds a
// user-supplied URL to fetch().
//
// Failure is always soft: a missing token/chat prints one line and returns
// {sent:false}; a network error prints to stderr and returns {sent:false}.
// This module never throws and never exits non-zero — a notification outage
// must not take down an autopilot run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main-module.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The single allowed network peer. Literal, never derived from input. */
const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const TELEGRAM_HOST = 'api.telegram.org';
const REQUEST_TIMEOUT_MS = 15000;

let dotenvLoaded = false;
async function loadDotenvOnce() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    // dotenv is optional — fall back to process.env alone when absent.
    const dotenv = await import('dotenv');
    dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });
  } catch {
    // no dotenv → rely on the ambient environment
  }
}

/**
 * Send one HTML-mode message to the configured chat.
 *
 * @param {string} text - message body (HTML parse mode: escape &, <, > in any
 *   dynamic fragment before they reach here — see autopilot.mjs's escapeHtml).
 * @returns {Promise<{sent: boolean, reason?: string, error?: string}>}
 */
export async function sendTelegram(text) {
  await loadDotenvOnce();
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const chatId = (process.env.TG_CHAT_ID || '').trim();
  if (!token || !chatId) {
    console.log('[tg] disabled: TG_BOT_TOKEN/TG_CHAT_ID not set');
    return { sent: false, reason: 'not-configured' };
  }

  // Built only from the pinned origin + the env token (encoded so a malformed
  // token can't alter the path or host). `text` never touches this URL.
  const url = new URL(`${TELEGRAM_API_ORIGIN}/bot${encodeURIComponent(token)}/sendMessage`);
  if (url.hostname !== TELEGRAM_HOST || url.origin !== TELEGRAM_API_ORIGIN) {
    // Unreachable by construction; kept as defense in depth so a future edit
    // that builds the URL differently fails closed, not open.
    return { sent: false, reason: 'host-allowlist-violation' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text ?? ''),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[tg] sendMessage failed: HTTP ${res.status} ${body.slice(0, 300)}`);
      return { sent: false, reason: `http-${res.status}` };
    }
    console.log('[tg] sent');
    return { sent: true };
  } catch (err) {
    console.error(`[tg] send failed: ${err?.message ?? err}`);
    return { sent: false, reason: 'network-error', error: String(err?.message ?? err) };
  }
}

// ── CLI ─────────────────────────────────────────────────────────────
//   node notify-tg.mjs "some text"   → send text
//   node notify-tg.mjs --test        → send a fixed test message
// Always exits 0, even on failure (soft-fail by design).

async function cliMain() {
  const args = process.argv.slice(2);
  if (args.includes('--test')) {
    const result = await sendTelegram('career-ops autopilot: Telegram test message (HTML mode OK)');
    console.log(JSON.stringify(result));
    return;
  }
  const text = args.find(a => !a.startsWith('--'));
  if (!text) {
    console.log('Usage: node notify-tg.mjs "text" | node notify-tg.mjs --test');
    return;
  }
  const result = await sendTelegram(text);
  console.log(JSON.stringify(result));
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  cliMain().catch((err) => {
    // Soft-fail even here: print, exit 0.
    console.error(`[tg] unexpected error: ${err?.message ?? err}`);
  });
}
