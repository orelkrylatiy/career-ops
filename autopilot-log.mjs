#!/usr/bin/env node
// Structured append-only audit log for the autonomous worker.
//
// SQLite remains the queryable state store. JSONL is the human-readable trail
// for debugging one run without opening the database. Never write form values,
// credentials, cookies, tokens, email addresses, phone numbers, or answers here.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
export const AUTOPILOT_LOG_DIR = path.join(DATA_ROOT, 'data', 'autopilot', 'logs');

const SENSITIVE_KEY_RE = /(?:password|passwd|secret|token|cookie|authorization|email|phone|answer|typed_value|field_value|full_name|value)/i;
const MAX_STRING = 1200;

function safeRunId(raw) {
  const value = String(raw ?? '').trim().replace(/[^a-z0-9._-]/gi, '-').slice(0, 100);
  return value || null;
}

export function sanitizeLogPayload(value, key = '') {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeLogPayload(item));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeLogPayload(v, k);
    return out;
  }
  return String(value);
}

export function auditLogPath(date = new Date()) {
  return path.join(AUTOPILOT_LOG_DIR, date.toISOString().slice(0, 10) + '.jsonl');
}

export function auditLog(event, payload = {}, { level = 'info', date = new Date() } = {}) {
  const row = {
    ts: date.toISOString(),
    run_id: safeRunId(process.env.AUTOPILOT_RUN_ID),
    level,
    event: String(event || 'event'),
    ...sanitizeLogPayload(payload),
  };
  const file = auditLogPath(date);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  return row;
}
