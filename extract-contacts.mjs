#!/usr/bin/env node
// extract-contacts.mjs — parse recruiter/hiring contacts from the last browser
// state dump (data/browser-state.json) and upsert them into the autopilot DB.
// Offline: reads the dump file only; no network. Run after autopilot-browser.mjs
// dumped the page you want to mine.
//
// Usage: node extract-contacts.mjs [--source "<url override>"] [--dry-run]

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { openDb, upsertContact } from './autopilot-db.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const STATE = resolve(DATA_ROOT, 'data', 'browser-state.json');

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi;
const TG_RE = /(?:^|[\s(])@(?:t\.me\/)?([a-z0-9_]{4,32})/gi;
const JUNK_EMAIL_RE = /@(example|sentry|w3|schema|localhost|\d+\.\d+\.\d+\.\d+)/i;
// RU market-map rule: generic inboxes are NOT application channels. Still
// saved (evidence), but flagged low-value so outreach skips them.
const GENERIC_INBOX_RE = /^(support|info|sales|help|no-?reply|admin|office|contact)@/i;
const JUNK_TG = new Set(['example', 'username', 'media', 'font', 'keyframes', 'global', 'import', 'export', 'types', 'context']);

function uniq(arr) { return [...new Set(arr)]; }

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const srcIdx = argv.indexOf('--source');
const source = srcIdx !== -1 ? argv[srcIdx + 1] : null;

let state;
try {
  state = JSON.parse(readFileSync(STATE, 'utf8'));
} catch (e) {
  console.error(`[extract-contacts] cannot read ${STATE}: ${e.message}`);
  process.exit(1);
}
const pageUrl = source || state.url || '(unknown)';

const haystack = [
  state.bodyText || '',
  ...(state.links || []).map((l) => `${l.text} ${l.href}`),
  ...(state.fields || []).map((f) => `${f.name} ${f.placeholder || ''} ${f.value || ''}`),
].join('\n');

const emails = uniq((haystack.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))
  .filter((e) => !JUNK_EMAIL_RE.test(e));
const linkTgs = uniq(
  (haystack.match(/t\.me\/([a-z0-9_]{4,32})/gi) || []).map((s) => s.replace(/t\.me\//i, '').toLowerCase()),
);
const handleTgs = uniq(
  [...haystack.matchAll(TG_RE)].map((m) => m[1].toLowerCase()),
).filter((h) => !JUNK_TG.has(h));
const tgHandles = uniq([...linkTgs, ...handleTgs]);

console.log(`page: ${pageUrl}`);
console.log(`emails found: ${emails.length ? emails.join(', ') : '(none)'}`);
console.log(`telegram handles: ${tgHandles.length ? tgHandles.join(', ') : '(none)'}`);
const generic = emails.filter((e) => GENERIC_INBOX_RE.test(e));
if (generic.length) console.log(`low-value generic inboxes (do NOT use for outreach): ${generic.join(', ')}`);

if (dryRun) { console.log('(dry-run: nothing written)'); process.exit(0); }

const db = openDb();
let saved = 0;
for (const email of emails) {
  const isGeneric = GENERIC_INBOX_RE.test(email);
  upsertContact({ name: null, role: isGeneric ? 'generic-inbox' : null, company: null, email, linkedin: null, source: pageUrl });
  saved++;
}
for (const tg of tgHandles) {
  upsertContact({ name: null, role: null, company: null, email: null, linkedin: `t.me/${tg}`, source: pageUrl });
  saved++;
}
console.log(`saved contacts: ${saved} (db: data/autopilot.db)`);
