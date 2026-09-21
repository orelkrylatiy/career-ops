#!/usr/bin/env node
// autopilot-telegram.mjs — reliable outbound Telegram notifications.
//
// Telegram is intentionally an OBSERVABILITY channel, never part of the submit
// critical path. Application results are first committed to SQLite together
// with an outbox row. Delivery is retried from the outbox and can fail without
// changing an already-recorded application.
//
// Secrets live only in environment variables:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
// They are never written to SQLite, audit logs, or profile.yml.

import {
  pendingNotifications,
  markNotificationSent,
  markNotificationFailed,
} from './autopilot-db.mjs';

const DEFAULT_OUTCOMES = [
  'applied',
  'submitted_unconfirmed',
  'validation_failed',
  'captcha',
  'failed',
];

function strings(value) {
  return (Array.isArray(value) ? value : [])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

export function telegramSettings(profile = {}, env = process.env) {
  const raw = profile?.autopilot?.notifications?.telegram;
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const outcomes = strings(cfg.outcomes);
  return {
    enabled: cfg.enabled === true,
    outcomes: outcomes.length ? outcomes : DEFAULT_OUTCOMES,
    token: typeof env.TELEGRAM_BOT_TOKEN === 'string' ? env.TELEGRAM_BOT_TOKEN.trim() : '',
    chatId: typeof env.TELEGRAM_CHAT_ID === 'string' ? env.TELEGRAM_CHAT_ID.trim() : '',
    disableWebPreview: cfg.disable_web_preview !== false,
  };
}

export function shouldNotifyOutcome(settings, outcome) {
  return Boolean(settings?.enabled && settings.outcomes?.includes(String(outcome || '')));
}

export function telegramReadiness(profile = {}, env = process.env) {
  const settings = telegramSettings(profile, env);
  if (!settings.enabled) return { enabled: false, ok: true, missing: [] };
  const missing = [];
  if (!settings.token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!settings.chatId) missing.push('TELEGRAM_CHAT_ID');
  return { enabled: true, ok: missing.length === 0, missing };
}

export function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function durationLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${Math.round(n)} ms`;
  const secs = Math.round(n / 1000);
  if (secs < 60) return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

const OUTCOME_LABELS = {
  applied: ['✅', 'Application submitted'],
  submitted_unconfirmed: ['⚠️', 'Submission unconfirmed'],
  validation_failed: ['🧩', 'Validation failed'],
  captcha: ['🛑', 'Human verification required'],
  failed: ['❌', 'Application failed'],
  skipped: ['⏭️', 'Application skipped'],
};

export function renderTelegramApplicationMessage(payload = {}) {
  const [icon, heading] = OUTCOME_LABELS[payload.outcome] || ['ℹ️', 'Application update'];
  const lines = [`${icon} <b>${escapeTelegramHtml(heading)}</b>`, ''];

  const field = (label, value) => {
    if (value == null || String(value).trim() === '') return;
    lines.push(`<b>${escapeTelegramHtml(label)}:</b> ${escapeTelegramHtml(value)}`);
  };

  field('Company', payload.company);
  field('Role', payload.title);
  field('Location', payload.location);
  field('Profile', payload.profile_label || payload.profile);
  if (Array.isArray(payload.stack) && payload.stack.length) field('Stack', payload.stack.join(', '));
  field('ATS', payload.ats);
  field('Resume', payload.resume_variant);
  field('Source', payload.source);
  if (Number.isFinite(Number(payload.priority))) field('Priority', `${Number(payload.priority)}/100`);
  const duration = durationLabel(payload.duration_ms);
  if (duration) field('Time', duration);

  if (payload.url) {
    const safe = escapeTelegramHtml(payload.url);
    lines.push('', `<a href="${safe}">Open vacancy</a>`);
  }
  return lines.join('\n');
}

export async function sendTelegramMessage(settings, text, {
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!settings?.token || !settings?.chatId) {
    throw new Error('Telegram credentials are not configured');
  }
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');

  // Never include this URL in thrown/logged diagnostics: it contains the bot
  // token. Only the status code is surfaced on failure.
  const endpoint = `https://api.telegram.org/bot${settings.token}/sendMessage`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: settings.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: settings.disableWebPreview,
    }),
  });
  if (!response?.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  return true;
}

export async function flushTelegramNotifications({
  profile = {},
  env = process.env,
  limit = 25,
  fetchImpl = globalThis.fetch,
} = {}) {
  const settings = telegramSettings(profile, env);
  if (!settings.enabled) {
    return { enabled: false, configured: false, pending: 0, sent: 0, failed: 0 };
  }
  const readiness = telegramReadiness(profile, env);
  if (!readiness.ok) {
    return {
      enabled: true,
      configured: false,
      missing: readiness.missing,
      pending: pendingNotifications('telegram', limit).length,
      sent: 0,
      failed: 0,
    };
  }

  const rows = pendingNotifications('telegram', limit);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json || '{}');
      const text = row.event_type === 'application_result'
        ? renderTelegramApplicationMessage(payload)
        : escapeTelegramHtml(payload.message || row.event_type);
      await sendTelegramMessage(settings, text, { fetchImpl });
      markNotificationSent(row.id);
      sent++;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = settings.token
        ? rawMessage.split(settings.token).join('[redacted]')
        : rawMessage;
      markNotificationFailed(row.id, safeMessage);
      failed++;
    }
  }
  return {
    enabled: true,
    configured: true,
    pending: rows.length,
    sent,
    failed,
  };
}
