#!/usr/bin/env node
// Scoped Gmail OTP/confirmation lookup for authorized candidate sign-ups.
// No inbox dump, no state changes, no persistent verification secrets.
import 'dotenv/config';
import { Buffer } from 'node:buffer';
import { isMainModule } from './lib/is-main-module.mjs';
import { isAuthenticEmail } from './plugins/gmail/_helpers.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function parseMailArgs(argv) {
  const out = { command: argv[0], domain: null, urlHost: null, since: null, timeout: 120 };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(key + ' requires a value');
    if (key === '--domain') out.domain = value;
    else if (key === '--url-host') out.urlHost = value;
    else if (key === '--since') out.since = Number(value);
    else if (key === '--timeout') out.timeout = Number(value);
    else throw new Error('unknown mail option: ' + key);
  }
  if (!['doctor', 'wait'].includes(out.command)) throw new Error('usage: autopilot-mail.mjs <doctor|wait> [--domain sender.example --url-host app.example --since UNIX_SECONDS --timeout 120]');
  if (out.command === 'wait') {
    if (!out.domain || !out.since || !Number.isSafeInteger(out.since)) throw new Error('wait requires --domain and --since UNIX_SECONDS');
    if (out.since < Date.now() / 1000 - 900 || out.since > Date.now() / 1000 + 60) throw new Error('since must be within the last 15 minutes');
  }
  if (!Number.isInteger(out.timeout) || out.timeout < 1 || out.timeout > 300) throw new Error('--timeout must be 1..300 seconds');
  for (const domain of [out.domain, out.urlHost].filter(Boolean)) {
    if (!/^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain) || domain.length > 253) throw new Error('invalid domain');
  }
  return out;
}

export function matchesDomain(sender, expected) {
  const address = String(sender || '').match(/<([^<>\s]+@[^<>\s]+)>|([a-z0-9._%+-]+@[a-z0-9.-]+)/i);
  if (!address) return false;
  const domain = (address[1] || address[2]).split('@').pop().toLowerCase();
  return domain === expected.toLowerCase() || domain.endsWith('.' + expected.toLowerCase());
}

export function decodeMime(payload) {
  if (!payload || typeof payload !== 'object') return '';
  let text = '';
  if (payload.body?.data) {
    try { text += Buffer.from(payload.body.data, 'base64url').toString('utf8') + '\n'; } catch {}
  }
  for (const part of payload.parts || []) text += decodeMime(part);
  return text.slice(0, 150_000);
}

export function extractVerification(text, allowedHost = null) {
  const src = String(text || '');
  const codeMatch = src.match(/(?:verification|one.time|confirm(?:ation)?|security|login|sign.in|otp|код|подтвержден|одноразов)[^\n\r]{0,120}?\b(\d{4,8})\b/i)
    || src.match(/\b(\d{4,8})\b[^\n\r]{0,100}(?:verification|confirm|otp|код|подтвержден)/i);
  // Only provide a confirmation URL on an explicitly approved destination host.
  let link = null;
  if (allowedHost) {
    const urls = src.match(/https:\/\/[^\s"'<>]+/gi) || [];
    for (const candidate of urls.slice(0, 50)) {
      try {
        const url = new URL(candidate.replace(/&amp;/g, '&'));
        if (url.hostname === allowedHost || url.hostname.endsWith('.' + allowedHost)) {
          if (/verify|confirm|activate|registration|email/i.test(url.pathname + url.search)) {
            link = url.href;
            break;
          }
        }
      } catch {}
    }
  }
  return { code: codeMatch?.[1] || null, link };
}

async function accessToken(env, fetchFn = fetch) {
  const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: refresh } = env;
  if (!id || !secret || !refresh) throw new Error('Gmail OAuth not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error('Gmail OAuth refresh failed: HTTP ' + res.status);
  const data = await res.json();
  if (!data.access_token) throw new Error('Gmail did not return an access token');
  return data.access_token;
}

async function gmailJson(token, route, fetchFn) {
  const res = await fetchFn(API + route, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Gmail request failed: HTTP ' + res.status);
  return res.json();
}

export async function findVerification({ token, domain, urlHost = null, since, fetchFn = fetch }) {
  const q = 'after:' + Math.floor(since) + ' from:' + domain;
  const data = await gmailJson(token, '/messages?maxResults=30&q=' + encodeURIComponent(q), fetchFn);
  for (const item of (data.messages || []).slice(0, 30)) {
    const msg = await gmailJson(token, '/messages/' + encodeURIComponent(item.id) + '?format=full', fetchFn);
    if (Number(msg.internalDate) < since * 1000) continue;
    const headers = msg.payload?.headers || [];
    const from = headers.find(h => String(h.name).toLowerCase() === 'from')?.value || '';
    if (!matchesDomain(from, domain) || !isAuthenticEmail(headers)) continue;
    const subject = headers.find(h => String(h.name).toLowerCase() === 'subject')?.value || '';
    const found = extractVerification(subject + '\n' + decodeMime(msg.payload), urlHost);
    if (found.code || found.link) return found;
  }
  return null;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseMailArgs(argv);
  const token = await accessToken(env);
  if (opts.command === 'doctor') {
    const profile = await gmailJson(token, '/profile', fetch);
    if (!profile.emailAddress) throw new Error('Gmail profile lacks an email address');
    console.log('Gmail OAuth ready for inbox reads. Mailbox identity verified.');
    return;
  }
  const deadline = Date.now() + opts.timeout * 1000;
  while (Date.now() < deadline) {
    const result = await findVerification({ token, domain: opts.domain, urlHost: opts.urlHost, since: opts.since });
    if (result) {
      // Secret goes to the worker's terminal only. Never auditLog, save or publish this.
      console.log(JSON.stringify(result));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(10_000, deadline - Date.now())));
  }
  throw new Error('No fresh verification message from approved sender before timeout');
}

if (isMainModule(import.meta.url)) main().catch(e => {
  // Error text never includes response bodies, OAuth tokens, message contents or OTP.
  console.error('autopilot-mail: ' + e.message);
  process.exitCode = 1;
});
