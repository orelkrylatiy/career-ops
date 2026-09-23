#!/usr/bin/env node
import { validateFlags } from './lib/cli-flags.mjs';
/**
 * tg-bot.mjs — Telegram interface for career-ops multi-account stats.
 *
 * Long-running service: identifies the Telegram user against profiles.yml
 * (deny-by-default), then shows THAT profile's numbers — directions count,
 * applications, funnel — and per-direction detail. Zero new dependencies:
 * Node 20's fetch against the raw Bot API, getUpdates long polling.
 *
 * All routing/rendering lives in lib/tg-bot-core.mjs (unit-tested offline);
 * this file only moves bytes: poll → handleUpdate → execute calls.
 *
 * Run: node tg-bot.mjs                     # polling; TG_BOT_TOKEN from .env
 *      node tg-bot.mjs --dry-run ups.json  # print the API calls for fixture
 *                                          # updates, no token, no network
 *
 * Registry (profiles.yml, user layer) drives access:
 *   node profile.mjs add-profile maxim --name Maxim --tg 123456789 --admin
 *   node profile.mjs add-direction maxim analyst --name "Data Analyst"
 *
 * Offset persistence: data/.tg-bot-state.json — a restart does not replay
 * the last batch. Only ONE process per bot token may run (Telegram rejects
 * concurrent getUpdates with 409; we exit loudly on it).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { isMainModule } from './lib/is-main-module.mjs';
import { loadProfiles, directionRoot } from './lib/profile-registry.mjs';
import { computeDirectionStats, readProfileRecentRows } from './lib/profile-stats.mjs';
import { handleUpdate, RECORD_LEAD_METHOD } from './lib/tg-bot-core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(ROOT, 'data', '.tg-bot-state.json');
const LEADS_FILE = join(ROOT, 'data', 'tg-bot-leads.json');
const API_BASE = 'https://api.telegram.org';

const KNOWN_FLAGS = ['--dry-run', '--help', '-h'];
const USAGE = `Usage:
  node tg-bot.mjs                  # start polling (TG_BOT_TOKEN required)
  node tg-bot.mjs --dry-run <file> # offline: JSON array of Telegram updates in,
                                   # JSON array of Bot API calls out
  node tg-bot.mjs --help|-h`;

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, content, 'utf-8');
  // Same Windows-contention retry idiom as the tracker writes.
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function loadOffset() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')).offset ?? 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  try {
    atomicWrite(STATE_FILE, `${JSON.stringify({ offset, savedAt: new Date().toISOString() }, null, 2)}\n`);
  } catch (err) {
    console.error(`tg-bot: could not persist offset: ${err.message}`);
  }
}

function loadLeads() {
  try {
    const parsed = JSON.parse(readFileSync(LEADS_FILE, 'utf-8'));
    return Array.isArray(parsed.leads) ? parsed.leads : [];
  } catch {
    return [];
  }
}

function recordLead(lead, leads) {
  leads.push(lead);
  try {
    atomicWrite(LEADS_FILE, `${JSON.stringify({ leads }, null, 2)}\n`);
  } catch (err) {
    console.error(`tg-bot: could not persist lead: ${err.message}`);
  }
}

/** Build the bot context: registry + data providers bound to direction roots. */
export function buildContext(registry, { leads = [] } = {}) {
  const leadIds = new Set(leads.map((l) => String(l.user_id)));
  return {
    registry,
    leads: leadIds,
    now: new Date().toISOString(),
    addLead(lead) {
      leadIds.add(String(lead.user_id));
      recordLead(lead, leads);
    },
    statsFor(profileId, directionId) {
      try {
        return computeDirectionStats(directionRoot(profileId, directionId));
      } catch {
        return null; // a broken direction never takes the bot down
      }
    },
    recentRows(profileId, limit) {
      const profile = registry.profiles.find((p) => p.id === profileId);
      if (!profile) return [];
      const rootsById = Object.fromEntries(
        profile.directions.map((d) => [d.id, directionRoot(profileId, d.id)]),
      );
      try {
        return readProfileRecentRows(rootsById, limit);
      } catch {
        return [];
      }
    },
  };
}

export async function callTelegram(token, method, payload) {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: body.ok === true, description: body.description, result: body.result };
}

/**
 * A call carrying photoPath (repo-relative) uploads the file as multipart
 * instead of JSON. Missing asset degrades to the same caption as plain text,
 * so a stripped checkout never breaks onboarding.
 */
async function executePhotoCall(token, call) {
  const file = join(ROOT, call.photoPath);
  const { chat_id: chatId, caption, parse_mode: parseMode, reply_markup: replyMarkup } = call.payload;
  if (!existsSync(file)) {
    return callTelegram(token, 'sendMessage', {
      chat_id: chatId,
      text: caption,
      parse_mode: parseMode,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption);
  form.set('parse_mode', parseMode ?? 'HTML');
  if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
  const bytes = await readFile(file);
  form.set('photo', new Blob([bytes], { type: 'image/png' }), 'telegram-main-screen.png');
  const res = await fetch(`${API_BASE}/bot${token}/sendPhoto`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: body.ok === true, description: body.description, result: body.result };
}

async function executeCalls(token, calls, ctx) {
  for (const call of calls) {
    // Side-effect marker from the pure core: persist the access-request lead
    // instead of sending anything to Telegram.
    if (call.method === RECORD_LEAD_METHOD) {
      ctx.addLead?.(call.payload);
      continue;
    }
    // Transport errors (network blips, sleep/wake) must degrade to a logged
    // line, never kill the service — an unsent reply is recoverable on the
    // next update, a dead poller is not.
    try {
      const result = call.photoPath
        ? await executePhotoCall(token, call)
        : await callTelegram(token, call.method, call.payload);
      if (result.ok) continue;
      // Editing an unedited/old message is not worth a second message — skip it.
      if (call.method === 'editMessageText' && /not modified/.test(result.description ?? '')) continue;
      if (call.method === 'editMessageText' && !result.ok) {
        // Too old / deleted: fall back to sending a fresh message.
        const { message_id, ...rest } = call.payload;
        await callTelegram(token, 'sendMessage', rest);
        continue;
      }
      console.error(`tg-bot: ${call.method} failed: ${result.description ?? result.status}`);
    } catch (err) {
      console.error(`tg-bot: ${call.method} transport error: ${err.message}`);
    }
  }
}

async function pollOnce(token, offset) {
  const res = await fetch(`${API_BASE}/bot${token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`);
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) {
    throw new Error('another getUpdates poller is running for this token (409) — stop the other instance first');
  }
  if (!body.ok) {
    throw new Error(`getUpdates failed: ${body.description ?? res.status}`);
  }
  return body.result ?? [];
}

async function run(token, ctx) {
  let offset = loadOffset();
  console.error(`tg-bot: polling as token …${token.slice(-4)} (registry: ${ctx.registry.profiles.length} profile(s), offset ${offset})`);
  let backoffMs = 3000;
  for (;;) {
    let updates;
    try {
      updates = await pollOnce(token, offset);
      backoffMs = 3000;
    } catch (err) {
      console.error(`tg-bot: ${err.message}`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60000);
      continue;
    }
    for (const update of updates) {
      const calls = handleUpdate(update, ctx);
      await executeCalls(token, calls, ctx);
      offset = update.update_id + 1;
      saveOffset(offset);
    }
  }
}

async function dryRun(updateFile, ctx) {
  const updates = JSON.parse(readFileSync(updateFile, 'utf-8'));
  const out = [];
  for (const update of updates) {
    out.push({ update_id: update.update_id, calls: handleUpdate(update, ctx) });
  }
  console.log(JSON.stringify(out, null, 2));
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE);

  dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  const registry = loadProfiles();
  if (registry === null) {
    console.error('tg-bot: profiles.yml not found — nobody can log in. Create the first account:');
    console.error('  node profile.mjs add-profile <slug> --name "Name" --tg <telegram-id> --admin');
    process.exit(1);
  }
  const ctx = buildContext(registry, { leads: loadLeads() });

  const dryRunIdx = args.indexOf('--dry-run');
  if (dryRunIdx !== -1) {
    const file = args[dryRunIdx + 1];
    if (!file || !existsSync(file)) {
      console.error('tg-bot: --dry-run requires an existing file with a JSON array of updates');
      process.exit(1);
    }
    dryRun(file, ctx).catch((err) => { console.error(`tg-bot: ${err.message}`); process.exit(1); });
  } else {
    const token = process.env.TG_BOT_TOKEN?.trim();
    if (!token) {
      console.error('tg-bot: TG_BOT_TOKEN is not set. Add it to .env (create the bot with @BotFather):');
      console.error('  TG_BOT_TOKEN=123456:ABC…');
      process.exit(1);
    }
    run(token, ctx).catch((err) => { console.error(`tg-bot: ${err.message}`); process.exit(1); });
  }
}
