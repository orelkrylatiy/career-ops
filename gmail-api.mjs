#!/usr/bin/env node

// Local Gmail API transport. OAuth files stay outside the repository.
// Token storage: ~/.mail (shared local directory, not part of this repo).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAIL_DIR = path.resolve(process.env.CAREER_OPS_GMAIL_DIR || 'C:/Users/Maxim/.mail');
const CONFIG_FILE = path.join(MAIL_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(MAIL_DIR, 'credentials.json');
const TOKEN_FILE = path.join(MAIL_DIR, 'token.json');
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
function requireFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Gmail API file missing: ${file}`);
}

function oauthClient() {
  const data = readJson(CREDENTIALS_FILE);
  const client = data.installed || data.web;
  if (!client?.client_id || !client?.client_secret) throw new Error('Gmail OAuth client is incomplete');
  return client;
}

async function accessToken() {
  requireFile(CREDENTIALS_FILE); requireFile(TOKEN_FILE);
  const token = readJson(TOKEN_FILE);
  if (token.access_token && Number(token.expires_at || 0) > Date.now() / 1000 + 60) return token.access_token;
  if (!token.refresh_token) throw new Error('Gmail OAuth refresh token is missing');
  const client = oauthClient();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      refresh_token: token.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) throw new Error(`Gmail OAuth refresh failed: HTTP ${response.status}`);
  const refreshed = await response.json();
  writeJson(TOKEN_FILE, {...token, ...refreshed, expires_at: Date.now() / 1000 + Number(refreshed.expires_in || 3600)});
  return refreshed.access_token;
}

async function api(method, endpoint, options = {}) {
  const token = await accessToken();
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {'authorization': `Bearer ${token}`, ...(options.body ? {'content-type': 'application/json'} : {})},
    ...options,
  });
  if (!response.ok) throw new Error(`Gmail API ${method} ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

export async function profileEmail() {
  const configured = String(readJson(CONFIG_FILE).email || '').trim().toLowerCase();
  const profile = await api('GET', '/profile');
  const actual = String(profile.emailAddress || '').trim().toLowerCase();
  if (!actual || (configured && actual !== configured)) {
    throw new Error(`Gmail sender mismatch: configured=${configured || '(none)'} actual=${actual || '(none)'}`);
  }
  return actual;
}

export async function search(query, maxResults = 20) {
  return api('GET', `/messages?${new URLSearchParams({q: query, maxResults: String(maxResults)})}`);
}

export async function readMessage(id) { return api('GET', `/messages/${encodeURIComponent(id)}`); }

export async function send({to, subject, body}) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Invalid recipient email');
  const sender = await profileEmail();
  const lines = [`From: ${sender}`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body];
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
  return api('POST', '/messages/send', {body: JSON.stringify({raw})});
}

function usage() {
  console.log('node gmail-api.mjs profile | search <query> | read <id> | send <to> <subject> <body-file>');
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (command === 'profile') console.log(await profileEmail());
    else if (command === 'search') console.log(JSON.stringify(await search(args.join(' ')), null, 2));
    else if (command === 'read') console.log(JSON.stringify(await readMessage(args[0]), null, 2));
    else if (command === 'send') console.log(JSON.stringify(await send({to: args[0], subject: args[1], body: fs.readFileSync(path.resolve(ROOT, args[2]), 'utf8')}), null, 2));
    else usage();
  } catch (error) { console.error(`gmail-api: ${error.message}`); process.exitCode = 1; }
}
