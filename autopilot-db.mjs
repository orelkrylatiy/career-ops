#!/usr/bin/env node
// autopilot-db.mjs — SQLite journal for the autopilot's deterministic state.
//
// One file, data/autopilot.db (WAL), holds everything the autopilot remembers
// between runs: every job it has ever queued (jobs), every application attempt
// it was told about (applications), LLM spend accounting for future agent steps
// (llm_calls), contacts surfaced along the way (contacts), an append-only
// event log (events), and the per-day send counter the daily cap enforces
// (daily_state).
//
// Job status lifecycle: queued -> test_filled | applied | failed | captcha | skipped
//
// url_key reuses url-key.mjs's normalizeUrl — the repo's ONE canonical posting
// URL key (lowercased host, tracking params stripped, fragment and trailing
// slash dropped, query order-insensitive). It is a superset of this module's
// required normalization and reusing it means the autopilot and the tracker can
// never disagree about whether two URLs are the same posting. Its "no key is
// not a key" contract carries over: an unparseable URL yields '' and callers
// must treat that as unknown, never as a value that can match another ''.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizeUrl } from './url-key.mjs';

const DATA_ROOT = getCareerOpsRoot();

/** DB location. Env-overridable like every other data-layer path in the repo. */
export const DB_PATH = process.env.CAREER_OPS_AUTOPILOT_DB
  || path.join(DATA_ROOT, 'data', 'autopilot.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  url_key   TEXT PRIMARY KEY,
  url       TEXT,
  source    TEXT,
  company   TEXT,
  title     TEXT,
  location  TEXT,
  status    TEXT DEFAULT 'queued',
  first_seen TEXT,
  updated_at TEXT,
  note      TEXT
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_url_key TEXT,
  channel TEXT,
  ats TEXT,
  resume_variant TEXT,
  resume_path TEXT,
  duration_ms INTEGER,
  outcome TEXT,
  error TEXT,
  details_json TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  job_url_key TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  role TEXT,
  company TEXT,
  email TEXT,
  linkedin TEXT,
  source TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  level TEXT,
  category TEXT,
  message TEXT,
  json TEXT
);
CREATE TABLE IF NOT EXISTS daily_state (
  date TEXT PRIMARY KEY,
  applications_sent INTEGER DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_url_key);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

let dbHandle = null;

/**
 * Open (creating on first call) the autopilot DB. WAL for concurrent
 * read/write from the CLI and any agent step. Idempotent — returns the same
 * handle for the lifetime of the process.
 *
 * @returns {import('better-sqlite3').Database}
 */
export function openDb() {
  if (dbHandle) return dbHandle;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Existing fork databases predate the observability columns. CREATE TABLE IF
  // NOT EXISTS cannot evolve them, so migrate additively and idempotently.
  const applicationColumns = new Set(
    db.prepare('PRAGMA table_info(applications)').all().map((row) => row.name),
  );
  const addApplicationColumn = (name, type) => {
    if (!applicationColumns.has(name)) {
      db.exec(`ALTER TABLE applications ADD COLUMN ${name} ${type}`);
      applicationColumns.add(name);
    }
  };
  addApplicationColumn('ats', 'TEXT');
  addApplicationColumn('resume_variant', 'TEXT');
  addApplicationColumn('resume_path', 'TEXT');
  addApplicationColumn('duration_ms', 'INTEGER');
  addApplicationColumn('details_json', 'TEXT');
  dbHandle = db;
  return db;
}

/** Normalized posting-URL key ('' when the input is not an http(s) URL). */
export function normalizeUrlKey(raw) {
  return normalizeUrl(raw);
}

/**
 * Append one row to the event log.
 *
 * @param {string} category - short bucket ('run', 'scan', 'gate', 'report', 'cap')
 * @param {string} message  - human-readable one-liner
 * @param {object|null} [extra] - structured payload, serialized into `json`
 * @param {'info'|'warn'|'error'} [level='info']
 * @returns {number} inserted row id
 */
export function addEvent(category, message, extra = null, level = 'info') {
  const db = openDb();
  const info = db.prepare(
    'INSERT INTO events (ts, level, category, message, json) VALUES (?, ?, ?, ?, ?)',
  ).run(
    new Date().toISOString(),
    level,
    String(category ?? 'general'),
    String(message ?? ''),
    extra == null ? null : JSON.stringify(extra),
  );
  return Number(info.lastInsertRowid);
}

/**
 * Upsert a harvested contact. Dedup key: non-null email OR non-null linkedin —
 * a row with the same key gets its source/company refreshed instead of
 * duplicating. Rows with neither key are inserted as-is (best-effort notes).
 * @returns {number} row id
 */
export function upsertContact({ name, role, company, email, linkedin, source }) {
  const db = openDb();
  const norm = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const c = { name: norm(name), role: norm(role), company: norm(company), email: norm(email)?.toLowerCase() ?? null, linkedin: norm(linkedin), source: norm(source) };
  if (!c.email && !c.linkedin && !c.name) throw new Error('upsertContact: need at least one of email/linkedin/name');
  let existing = null;
  if (c.email) existing = db.prepare('SELECT id FROM contacts WHERE email = ?').get(c.email);
  if (!existing && c.linkedin) existing = db.prepare('SELECT id FROM contacts WHERE linkedin = ?').get(c.linkedin);
  if (existing) {
    db.prepare('UPDATE contacts SET name = COALESCE(?, name), role = COALESCE(?, role), company = COALESCE(?, company), source = COALESCE(?, source) WHERE id = ?')
      .run(c.name, c.role, c.company, c.source, existing.id);
    return existing.id;
  }
  const info = db.prepare(
    'INSERT INTO contacts (name, role, company, email, linkedin, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(c.name, c.role, c.company, c.email, c.linkedin, c.source, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/**
 * Insert-or-refresh one job row.
 *
 * ON CONFLICT deliberately PRESERVES `status` and `first_seen`: re-seeing a
 * posting in a later scan must never reset a job whose lifecycle already
 * progressed past 'queued'. The dedup step in autopilot.mjs means upsertJob is
 * normally only called for unseen keys; the conflict clause is the belt to
 * that braces.
 *
 * @param {{urlKey: string, url: string, source?: string, company?: string,
 *          title?: string, location?: string, note?: string, status?: string}} job
 */
export function upsertJob(job) {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO jobs (url_key, url, source, company, title, location, status, first_seen, updated_at, note)
    VALUES (@urlKey, @url, @source, @company, @title, @location, COALESCE(@status, 'queued'), @now, @now, @note)
    ON CONFLICT(url_key) DO UPDATE SET
      url        = COALESCE(NULLIF(excluded.url, ''), jobs.url),
      source     = COALESCE(NULLIF(excluded.source, ''), jobs.source),
      company    = COALESCE(NULLIF(excluded.company, ''), jobs.company),
      title      = COALESCE(NULLIF(excluded.title, ''), jobs.title),
      location   = COALESCE(NULLIF(excluded.location, ''), jobs.location),
      note       = CASE WHEN excluded.note IS NOT NULL AND excluded.note != '' THEN excluded.note ELSE jobs.note END,
      updated_at = excluded.updated_at
  `).run({
    urlKey: job.urlKey,
    url: job.url ?? null,
    source: job.source ?? null,
    company: job.company ?? null,
    title: job.title ?? null,
    location: job.location ?? null,
    status: job.status ?? 'queued',
    note: job.note ?? null,
    now,
  });
}

/** @returns {object|undefined} the jobs row for a url_key, if any */
export function getJob(urlKey) {
  return openDb().prepare('SELECT * FROM jobs WHERE url_key = ?').get(urlKey);
}

/**
 * @param {string|null|undefined} status - exact status, or all rows when falsy
 * @returns {object[]} oldest first (first_seen ASC, insertion order as tiebreak)
 */
export function listJobs(status) {
  const db = openDb();
  const sql = status
    ? 'SELECT * FROM jobs WHERE status = ? ORDER BY first_seen ASC, rowid ASC'
    : 'SELECT * FROM jobs ORDER BY first_seen ASC, rowid ASC';
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

/**
 * Record an outcome for a job: flip its status and append an applications row,
 * atomically.
 *
 * @param {string} urlKey
 * @param {'applied'|'test_filled'|'failed'|'captcha'|'skipped'} outcome
 * @param {string|null} [note]  - free-text note, stored on the job row
 * @param {string|null} [channel] - 'browser' | 'ats_api' | 'email'
 * @returns {boolean} true when a jobs row was actually updated
 */
export function reportOutcome(urlKey, outcome, note = null, channel = null, metadata = {}) {
  const db = openDb();
  const now = new Date().toISOString();
  const ats = metadata?.ats ? String(metadata.ats).slice(0, 120) : null;
  const resumeVariant = metadata?.resumeVariant ? String(metadata.resumeVariant).slice(0, 120) : null;
  const resumePath = metadata?.resumePath ? String(metadata.resumePath).slice(0, 500) : null;
  const durationMs = Number.isFinite(Number(metadata?.durationMs)) && Number(metadata.durationMs) >= 0
    ? Math.round(Number(metadata.durationMs))
    : null;
  const details = metadata?.details && typeof metadata.details === 'object'
    ? JSON.stringify(metadata.details)
    : null;
  const run = db.transaction(() => {
    const res = db.prepare(
      'UPDATE jobs SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE url_key = ?',
    ).run(outcome, note, now, urlKey);
    db.prepare(`
      INSERT INTO applications
        (job_url_key, channel, ats, resume_variant, resume_path, duration_ms, outcome, error, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      urlKey,
      channel ?? null,
      ats,
      resumeVariant,
      resumePath,
      durationMs,
      outcome,
      outcome === 'failed' ? (note ?? null) : null,
      details,
      now,
    );
    return res.changes > 0;
  });
  return run();
}

/** Recent event rows for CLI troubleshooting. */
export function recentEvents(limit = 50) {
  const n = Math.max(1, Math.min(500, Number.parseInt(String(limit), 10) || 50));
  return openDb().prepare(
    'SELECT id, ts, level, category, message, json FROM events ORDER BY id DESC LIMIT ?',
  ).all(n);
}

/** Aggregate application-attempt telemetry without exposing form values. */
export function applicationAnalytics() {
  const db = openDb();
  const grouped = (column) => db.prepare(
    `SELECT COALESCE(NULLIF(${column}, ''), '(unknown)') AS name, COUNT(*) AS n
     FROM applications GROUP BY name ORDER BY n DESC, name ASC`,
  ).all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM applications').get().n;
  const success = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE outcome = 'applied'").get().n;
  const topErrors = db.prepare(
    `SELECT error AS name, COUNT(*) AS n
     FROM applications
     WHERE error IS NOT NULL AND TRIM(error) != ''
     GROUP BY error ORDER BY n DESC, error ASC LIMIT 20`,
  ).all();
  return {
    total,
    applied: success,
    success_rate: total ? success / total : 0,
    by_outcome: grouped('outcome'),
    by_channel: grouped('channel'),
    by_ats: grouped('ats'),
    by_resume: grouped('resume_variant'),
    top_errors: topErrors,
  };
}


/**
 * Bump (creating if needed) the per-day applications counter and return the row.
 *
 * The date key is computed in LOCAL time, not SQL date('now') (UTC): a daily
 * send cap is a local-day concept — "100 per day" for a user in Yerevan must
 * not reset at 04:00 local (midnight UTC) mid-window.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @param {number} [delta=1]
 */
export function incrementDaily(date, delta = 1) {
  const db = openDb();
  db.prepare(`
    INSERT INTO daily_state (date, applications_sent, notes) VALUES (?, ?, NULL)
    ON CONFLICT(date) DO UPDATE SET applications_sent = applications_sent + excluded.applications_sent
  `).run(date, delta);
  return db.prepare('SELECT * FROM daily_state WHERE date = ?').get(date);
}

/** Canonical lifecycle statuses, in lifecycle order (for zero-filled reports). */
export const JOB_STATUSES = ['queued', 'applied', 'test_filled', 'failed', 'captcha', 'skipped'];

/** Per-status job counts, zero-filled over JOB_STATUSES plus any stray value. */
export function statusCounts() {
  const db = openDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
  const byStatus = new Map(rows.map(r => [r.status, r.n]));
  const out = {};
  for (const s of JOB_STATUSES) out[s] = byStatus.get(s) ?? 0;
  for (const [s, n] of byStatus) if (!(s in out)) out[s] = n; // non-canonical value: still show it
  return out;
}

// ── CLI: node autopilot-db.mjs status ───────────────────────────────

function cliMain() {
  const [cmd] = process.argv.slice(2);
  if (cmd && cmd !== 'status') {
    console.error('Usage: node autopilot-db.mjs status');
    process.exit(1);
  }
  const db = openDb();
  const counts = statusCounts();
  const totalJobs = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const totalApplications = db.prepare('SELECT COUNT(*) AS n FROM applications').get().n;
  console.log(`DB: ${DB_PATH}`);
  console.log(`jobs: ${totalJobs}`);
  for (const s of Object.keys(counts)) console.log(`  ${s}: ${counts[s]}`);
  console.log(`applications: ${totalApplications}`);
  console.log(`events: ${totalEvents}`);
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) cliMain();
