import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = mkdtempSync(path.join(tmpdir(), 'career-ops-legacy-db-'));
mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const dbPath = path.join(ROOT, 'data', 'autopilot.db');

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE jobs (
    url_key TEXT PRIMARY KEY,
    url TEXT,
    source TEXT,
    company TEXT,
    title TEXT,
    location TEXT,
    status TEXT DEFAULT 'queued',
    first_seen TEXT,
    updated_at TEXT,
    note TEXT
  );
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_url_key TEXT,
    channel TEXT,
    outcome TEXT,
    error TEXT,
    created_at TEXT
  );
  CREATE TABLE llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER,
    cost_usd REAL, job_url_key TEXT, created_at TEXT
  );
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, role TEXT, company TEXT, email TEXT, linkedin TEXT,
    source TEXT, created_at TEXT
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, level TEXT, category TEXT, message TEXT, json TEXT
  );
  CREATE TABLE daily_state (
    date TEXT PRIMARY KEY,
    applications_sent INTEGER DEFAULT 0,
    notes TEXT
  );
`);
legacy.prepare(`
  INSERT INTO jobs(url_key, url, company, title, status, first_seen, updated_at)
  VALUES (?, ?, ?, ?, 'queued', ?, ?)
`).run(
  'https://example.com/job/legacy',
  'https://example.com/job/legacy',
  'Legacy Co',
  'Engineer',
  '2026-09-01T00:00:00.000Z',
  '2026-09-01T00:00:00.000Z',
);
legacy.prepare(`
  INSERT INTO jobs(url_key, url, company, title, status, first_seen, updated_at)
  VALUES (?, ?, ?, ?, 'test_filled', ?, ?)
`).run(
  'https://example.com/job/filled-only',
  'https://example.com/job/filled-only',
  'Filled Only Co',
  'Engineer',
  '2026-09-02T00:00:00.000Z',
  '2026-09-02T00:00:00.000Z',
);
legacy.close();

process.env.CAREER_OPS_ROOT = ROOT;
const mod = await import(
  pathToFileURL(path.resolve('autopilot-db.mjs')).href + '?legacy=' + Date.now()
);

test('old autopilot DB migrates additively without losing queued jobs', () => {
  const db = mod.openDb();
  const jobCols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name));
  const appCols = new Set(db.prepare('PRAGMA table_info(applications)').all().map((r) => r.name));

  for (const name of [
    'priority', 'rank_reasons_json', 'posted_at',
    'claimed_at', 'claim_owner', 'claim_until', 'next_attempt_at',
  ]) {
    assert.equal(jobCols.has(name), true, name);
  }
  for (const name of [
    'ats', 'resume_variant', 'profile_key', 'resume_path', 'duration_ms', 'details_json',
  ]) {
    assert.equal(appCols.has(name), true, name);
  }

  const outboxCols = new Set(
    db.prepare('PRAGMA table_info(notification_outbox)').all().map((r) => r.name),
  );
  for (const name of [
    'id', 'channel', 'event_type', 'job_url_key', 'payload_json',
    'status', 'attempts', 'next_attempt_at', 'claim_owner', 'claim_until',
    'created_at', 'sent_at', 'last_error',
  ]) {
    assert.equal(outboxCols.has(name), true, `notification_outbox.${name}`);
  }

  const row = db.prepare('SELECT * FROM jobs WHERE company=?').get('Legacy Co');
  assert.equal(row.title, 'Engineer');
  assert.equal(row.status, 'queued');
  assert.equal(row.priority, 50);

  const filled = db.prepare('SELECT * FROM jobs WHERE company=?').get('Filled Only Co');
  assert.equal(filled.status, 'queued');
  assert.equal(filled.claim_owner, null);
});

test.after(() => {
  try { mod.openDb().close(); } catch {}
  rmSync(ROOT, { recursive: true, force: true });
});
