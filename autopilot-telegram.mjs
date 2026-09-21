// autopilot-telegram.mjs — reliable Telegram notifications for autonomous applications.
//
// Delivery uses Telegram Bot API sendMessage. Application events are first
// written to SQLite's notification_outbox in the same transaction as the
// application result; this module only drains that outbox. Telegram failures
// therefore never roll back or misclassify a real application.

import {
  claimPendingNotifications,
  markNotificationSent,
  markNotificationFailed,
  pendingNotificationCount,
  statusCounts,
  applicationAnalytics,
  dailyCount,
} from './autopilot-db.mjs';

const DEFAULT_OUTCOMES = [
  'applied',
  'submitted_unconfirmed',
  'captcha',
  'validation_failed',
];

function normalizeOutcomes(value) {
  return (Array.isArray(value) ? value : DEFAULT_OUTCOMES)
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

export function telegramConfig(profile, env = process.env) {
  const raw = profile?.autopilot?.notifications?.telegram || {};
  const tokenEnv = typeof raw.token_env === 'string' && raw.token_env.trim()
    ? raw.token_env.trim()
    : 'TELEGRAM_BOT_TOKEN';
  const chatIdEnv = typeof raw.chat_id_env === 'string' && raw.chat_id_env.trim()
    ? raw.chat_id_env.trim()
    : 'TELEGRAM_CHAT_ID';
  return {
    enabled: raw.enabled === true,
    tokenEnv,
    chatIdEnv,
    token: env[tokenEnv] || '',
    chatId: env[chatIdEnv] || '',
    outcomes: normalizeOutcomes(raw.outcomes),
    silent: raw.silent === true,
  };
}

export function shouldQueueTelegram(profile, outcome) {
  const cfg = telegramConfig(profile);
  return cfg.enabled && cfg.outcomes.includes(outcome);
}

export function telegramPreflight(profile, env = process.env) {
  const cfg = telegramConfig(profile, env);
  if (!cfg.enabled) return { enabled: false, ok: true, warnings: [] };
  const warnings = [];
  if (!cfg.token) warnings.push(`${cfg.tokenEnv} is missing`);
  if (!cfg.chatId) warnings.push(`${cfg.chatIdEnv} is missing`);
  return { enabled: true, ok: warnings.length === 0, warnings };
}

function iconFor(outcome) {
  if (outcome === 'applied') return '✅';
  if (outcome === 'submitted_unconfirmed') return '⚠️';
  if (outcome === 'captcha') return '🧩';
  if (outcome === 'validation_failed') return '📝';
  if (outcome === 'failed') return '❌';
  return 'ℹ️';
}

function labelFor(outcome) {
  const labels = {
    applied: 'Application submitted',
    submitted_unconfirmed: 'Submission needs review',
    captcha: 'CAPTCHA / human check',
    validation_failed: 'Validation failed',
    failed: 'Application failed',
    skipped: 'Application skipped',
  };
  return labels[outcome] || outcome;
}

function safeText(value, fallback = '—') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export function formatTelegramApplication(payload, context = {}) {
  const { job = {}, outcome, metadata = {}, profile = null } = payload || {};
  const lines = [
    `${iconFor(outcome)} ${labelFor(outcome)}`,
    '',
    `Company: ${safeText(job.company)}`,
    `Role: ${safeText(job.title)}`,
  ];
  if (job.location) lines.push(`Location: ${job.location}`);
  if (metadata.ats) lines.push(`ATS: ${metadata.ats}`);
  if (profile?.label || metadata.profileKey) {
    lines.push(`Profile: ${profile?.label || metadata.profileKey}`);
  }
  if (profile?.stack?.length) lines.push(`Stack: ${profile.stack.join(', ')}`);
  if (metadata.resumeVariant) lines.push(`Resume: ${metadata.resumeVariant}`);
  if (Number.isFinite(Number(job.priority))) lines.push(`Priority: ${job.priority}/100`);
  if (Number.isFinite(Number(metadata.durationMs))) {
    lines.push(`Time: ${Math.max(1, Math.round(Number(metadata.durationMs) / 1000))}s`);
  }

  const telemetry = [];
  if (Number.isFinite(Number(context.today))) telemetry.push(`today ${context.today}`);
  if (Number.isFinite(Number(context.queue))) telemetry.push(`queue ${context.queue}`);
  if (Number.isFinite(Number(context.profileApplied)) && metadata.profileKey) {
    telemetry.push(`${metadata.profileKey} applied ${context.profileApplied}`);
  }
  if (telemetry.length) lines.push('', `Stats: ${telemetry.join(' · ')}`);
  if (job.url) lines.push('', job.url);

  return lines.join('\n').slice(0, 4096);
}

export async function sendTelegramMessage({ token, chatId, text, silent = false, fetchImpl = fetch }) {
  if (!token) throw new Error('Telegram bot token is missing');
  if (!chatId) throw new Error('Telegram chat id is missing');

  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_notification: Boolean(silent),
      link_preview_options: { is_disabled: true },
    }),
  });

  let body = null;
  try { body = await response.json(); } catch { /* preserve HTTP error below */ }
  if (!response.ok || body?.ok === false) {
    const detail = body?.description || `HTTP ${response.status}`;
    throw new Error(`Telegram sendMessage failed: ${detail}`);
  }
  return body?.result || null;
}

function nextRetryIso(attempts) {
  const minutes = Math.min(360, 5 * (2 ** Math.max(0, attempts)));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function flushTelegramOutbox({
  profile,
  env = process.env,
  limit = 20,
  fetchImpl = fetch,
} = {}) {
  const cfg = telegramConfig(profile, env);
  const pendingBefore = pendingNotificationCount('telegram');
  if (!cfg.enabled) return { enabled: false, sent: 0, failed: 0, pending: pendingBefore };
  if (!cfg.token || !cfg.chatId) {
    return {
      enabled: true,
      sent: 0,
      failed: 0,
      pending: pendingBefore,
      error: 'telegram credentials missing',
    };
  }

  const owner = `telegram-${process.pid}`;
  const rows = claimPendingNotifications('telegram', owner, limit, 5);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch {
      markNotificationFailed(row.id, 'invalid payload JSON', nextRetryIso(row.attempts || 0), owner);
      failed++;
      continue;
    }

    const counts = statusCounts();
    const profileKey = payload?.metadata?.profileKey || null;
    const profileStats = profileKey ? applicationAnalytics(profileKey) : null;
    const text = formatTelegramApplication(payload, {
      today: dailyCount(localDateStr()),
      queue: counts.queued || 0,
      profileApplied: profileStats?.applied,
    });

    try {
      await sendTelegramMessage({
        token: cfg.token,
        chatId: cfg.chatId,
        text,
        silent: cfg.silent,
        fetchImpl,
      });
      markNotificationSent(row.id, owner);
      sent++;
    } catch (err) {
      markNotificationFailed(
        row.id,
        err instanceof Error ? err.message : String(err),
        nextRetryIso(row.attempts || 0),
        owner,
      );
      failed++;
    }
  }

  return {
    enabled: true,
    sent,
    failed,
    pending: pendingNotificationCount('telegram'),
  };
}

export function telegramStatus(profile, env = process.env) {
  const preflight = telegramPreflight(profile, env);
  return {
    ...preflight,
    pending: pendingNotificationCount('telegram'),
  };
}
