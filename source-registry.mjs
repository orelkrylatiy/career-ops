#!/usr/bin/env node
// source-registry.mjs — regional source/company registry for the wide-funnel
// autonomous search lane.
//
// Canonical source definitions live in catalog/source-catalog.yml (system
// layer). Runtime health, discovered companies and resolved ATS boards live in
// data/source-registry.db (user/runtime layer). There is intentionally no
// Career-Ops-side company/application/discovery count ceiling.
//
// Usage:
//   node source-registry.mjs init
//   node source-registry.mjs sync [--country RU]
//   node source-registry.mjs verify [--country KZ]
//   node source-registry.mjs resolve [--country AM]
//   node source-registry.mjs export
//   node source-registry.mjs full
//   node source-registry.mjs status [--json]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { fetchTextWithRetry, makeHttpCtx } from './providers/_http.mjs';
import { resolveCompany } from './discover-ats.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  DIRECTORY_PARSERS,
  healthKind,
  normalizeCompanyKey,
  sourceLocale,
} from './catalog/registry-core.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const CATALOG_PATH = path.join(CODE_ROOT, 'catalog', 'source-catalog.yml');
const DB_PATH = process.env.CAREER_OPS_SOURCE_DB || path.join(DATA_ROOT, 'data', 'source-registry.db');
const EXPORT_PATH = process.env.CAREER_OPS_EXPANDED_PORTALS
  || path.join(DATA_ROOT, 'data', 'portals-regional.generated.yml');
const USER_PORTALS = process.env.CAREER_OPS_PORTALS || path.join(DATA_ROOT, 'portals.yml');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  country TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  provider TEXT,
  access TEXT,
  configured_status TEXT,
  locales_json TEXT,
  notes TEXT,
  last_health TEXT,
  last_http_status INTEGER,
  last_checked_at TEXT,
  last_error TEXT,
  metadata_json TEXT
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  name TEXT NOT NULL,
  rank INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  seed_source TEXT NOT NULL,
  external_id TEXT,
  website TEXT,
  directory_url TEXT,
  seed_status TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  metadata_json TEXT,
  UNIQUE(country, normalized_key)
);
CREATE TABLE IF NOT EXISTS company_memberships (
  source_id TEXT NOT NULL,
  company_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY(source_id, company_id),
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS company_sources (
  company_id INTEGER NOT NULL,
  provider TEXT,
  careers_url TEXT NOT NULL,
  api TEXT,
  status TEXT NOT NULL,
  job_count INTEGER,
  verified_at TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY(company_id, careers_url),
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS registry_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  action TEXT NOT NULL,
  country TEXT,
  ok INTEGER,
  summary_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(country);
CREATE INDEX IF NOT EXISTS idx_companies_priority ON companies(country, priority, rank);
CREATE INDEX IF NOT EXISTS idx_company_memberships_status ON company_memberships(source_id, status);
CREATE INDEX IF NOT EXISTS idx_company_sources_status ON company_sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_country ON sources(country);
`;

let dbHandle = null;

export function openRegistryDb() {
  if (dbHandle) return dbHandle;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  dbHandle = db;
  return db;
}

function loadCatalog() {
  const doc = yaml.load(readFileSync(CATALOG_PATH, 'utf8'));
  if (!doc || typeof doc !== 'object') throw new Error('source catalog is not a YAML object');
  return doc;
}

function now() {
  return new Date().toISOString();
}

function countryMatch(value, country) {
  return !country || String(value || '').toUpperCase() === country;
}

function allCatalogSources(catalog) {
  const rows = [];
  for (const item of catalog.job_sources || []) rows.push({ ...item, kind: item.kind || 'aggregator' });
  for (const item of catalog.global_sources || []) rows.push({ ...item, country: null, kind: item.kind || 'global' });
  for (const item of catalog.company_directories || []) rows.push({
    ...item,
    kind: 'company-directory',
    access: item.access || 'public-html',
  });
  return rows;
}

export function upsertCatalog(catalog = loadCatalog()) {
  const db = openRegistryDb();
  const stmt = db.prepare(`
    INSERT INTO sources
      (id, country, kind, name, url, provider, access, configured_status, locales_json, notes, metadata_json)
    VALUES
      (@id, @country, @kind, @name, @url, @provider, @access, @configuredStatus, @locales, @notes, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      country=excluded.country,
      kind=excluded.kind,
      name=excluded.name,
      url=excluded.url,
      provider=excluded.provider,
      access=excluded.access,
      configured_status=excluded.configured_status,
      locales_json=excluded.locales_json,
      notes=excluded.notes,
      metadata_json=excluded.metadata_json
  `);
  const tx = db.transaction((rows) => {
    for (const item of rows) {
      stmt.run({
        id: item.id,
        country: item.country || null,
        kind: item.kind || 'aggregator',
        name: item.name || item.id,
        url: item.url || null,
        provider: item.provider || null,
        access: item.access || null,
        configuredStatus: item.status || null,
        locales: JSON.stringify(sourceLocale(item.country, item.locales)),
        notes: item.notes || null,
        metadata: JSON.stringify(item),
      });
    }
  });
  const rows = allCatalogSources(catalog);
  tx(rows);
  return rows.length;
}

function upsertCompany(country, source, company) {
  const db = openRegistryDb();
  const key = normalizeCompanyKey(company.name);
  if (!key) return null;
  const ts = now();
  db.prepare(`
    INSERT INTO companies
      (country, normalized_key, name, rank, priority, seed_source, external_id,
       website, directory_url, seed_status, first_seen, last_seen, metadata_json)
    VALUES
      (@country, @key, @name, @rank, @priority, @source, @externalId,
       @website, @directoryUrl, @seedStatus, @ts, @ts, @metadata)
    ON CONFLICT(country, normalized_key) DO UPDATE SET
      name=excluded.name,
      rank=COALESCE(excluded.rank, companies.rank),
      priority=MAX(companies.priority, excluded.priority),
      external_id=COALESCE(excluded.external_id, companies.external_id),
      website=COALESCE(excluded.website, companies.website),
      directory_url=COALESCE(excluded.directory_url, companies.directory_url),
      seed_status=excluded.seed_status,
      last_seen=excluded.last_seen,
      metadata_json=excluded.metadata_json
  `).run({
    country,
    key,
    name: company.name,
    rank: Number.isInteger(company.rank) ? company.rank : null,
    priority: company.priority ? 1 : 0,
    source,
    externalId: company.externalId || null,
    website: company.website || null,
    directoryUrl: company.directoryUrl || null,
    seedStatus: company.status || 'listed',
    ts,
    metadata: JSON.stringify(company),
  });
  const companyId = db.prepare('SELECT id FROM companies WHERE country = ? AND normalized_key = ?').get(country, key)?.id || null;
  if (companyId) {
    db.prepare(`
      INSERT INTO company_memberships(source_id, company_id, status, last_seen, metadata_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, company_id) DO UPDATE SET
        status=excluded.status,
        last_seen=excluded.last_seen,
        metadata_json=excluded.metadata_json
    `).run(source, companyId, company.status || 'listed', ts, JSON.stringify(company));
  }
  return companyId;
}

function pageUrl(raw, page) {
  const u = new URL(raw);
  u.searchParams.set('page', String(page));
  return u.href;
}

function rowIdentity(row) {
  return String(row.externalId || row.name || '').trim().toLowerCase();
}

async function fetchOne(url, ctx) {
  return fetchTextWithRetry(ctx, url, { redirect: 'error' }, { retries: 2 });
}

async function fetchDirectory(entry, ctx) {
  const parser = DIRECTORY_PARSERS[entry.parser];
  if (!parser) throw new Error('unknown directory parser: ' + entry.parser);

  if (entry.parser !== 'astanahub-participants' && entry.parser !== 'astanahub-companies') {
    const html = await fetchOne(entry.url, ctx);
    return parser(html, entry.url);
  }

  const out = [];
  const seen = new Set();
  let page = 1;
  while (true) {
    const url = pageUrl(entry.url, page);
    const html = await fetchOne(url, ctx);
    const rows = parser(html, url);
    let added = 0;
    for (const row of rows) {
      const id = rowIdentity(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(row);
      added += 1;
    }
    // No arbitrary page ceiling: stop only when the directory stops producing
    // rows/new identities. This is a termination condition, not a funnel limit.
    if (rows.length === 0 || added === 0) break;
    page += 1;
  }
  return out;
}

function isActiveDirectoryRow(entry, row) {
  if (!Array.isArray(entry.active_statuses) || entry.active_statuses.length === 0) return true;
  const actual = String(row.status || '').trim().toLowerCase();
  return entry.active_statuses.some((v) => String(v).trim().toLowerCase() === actual);
}

async function syncDirectories(country = null) {
  const catalog = loadCatalog();
  upsertCatalog(catalog);
  const entries = (catalog.company_directories || []).filter((e) => countryMatch(e.country, country));
  const ctx = makeHttpCtx();
  const summary = { directories: 0, parsed: 0, active: 0, byCountry: {} };

  for (const entry of entries) {
    // Membership is refreshed as a snapshot. Anything not seen again remains
    // in historical companies but no longer counts as a current directory member.
    openRegistryDb().prepare("UPDATE company_memberships SET status='not_seen_current_refresh' WHERE source_id=?")
      .run(entry.id);
    const rows = await fetchDirectory(entry, ctx);
    let kept = 0;
    for (const company of rows) {
      if (!isActiveDirectoryRow(entry, company)) continue;
      upsertCompany(entry.country, entry.id, company);
      kept += 1;
    }
    summary.directories += 1;
    summary.parsed += rows.length;
    summary.active += kept;
    summary.byCountry[entry.country] = (summary.byCountry[entry.country] || 0) + kept;
    console.log(entry.id + ': parsed=' + rows.length + ' kept=' + kept);
  }

  const minimum = Number(catalog.policy?.minimum_company_seed_per_country) || 200;
  for (const code of Object.keys(catalog.regions || {})) {
    if (!countryMatch(code, country)) continue;
    const n = openRegistryDb().prepare('SELECT COUNT(*) AS n FROM companies WHERE country = ?').get(code)?.n || 0;
    if (n < minimum) console.error('warning: ' + code + ' company seed below target floor: ' + n + '/' + minimum);
  }
  return summary;
}

async function verifySources(country = null) {
  const db = openRegistryDb();
  upsertCatalog();
  const rows = db.prepare(`
    SELECT * FROM sources
    WHERE url IS NOT NULL AND (? IS NULL OR country = ? OR country IS NULL)
    ORDER BY country, kind, name
  `).all(country, country);
  const ctx = makeHttpCtx();
  const summary = { checked: 0, reachable: 0, auth: 0, throttled: 0, gone: 0, errors: 0 };

  for (const row of rows) {
    let kind = 'unknown';
    let httpStatus = null;
    let error = null;
    try {
      const response = await ctx.fetchResponse(row.url, { redirect: 'manual', timeoutMs: 15000 });
      httpStatus = response.status;
      kind = healthKind(httpStatus);
    } catch (err) {
      httpStatus = Number.isInteger(err?.status) ? err.status : null;
      kind = httpStatus ? healthKind(httpStatus) : 'network';
      error = err?.message || String(err);
    }
    db.prepare(`
      UPDATE sources
      SET last_health = ?, last_http_status = ?, last_checked_at = ?, last_error = ?
      WHERE id = ?
    `).run(kind, httpStatus, now(), error, row.id);
    summary.checked += 1;
    if (kind in summary) summary[kind] += 1;
    else summary.errors += 1;
    console.log(row.id + ': ' + kind + (httpStatus ? ' HTTP ' + httpStatus : ''));
  }
  return summary;
}

async function parallelMap(rows, concurrency, fn) {
  let cursor = 0;
  const results = new Array(rows.length);
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      results[i] = await fn(rows[i], i);
    }
  }
  const count = Math.max(1, Math.min(concurrency, rows.length || 1));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function resolveCompanySources(country = null) {
  const db = openRegistryDb();
  const companies = db.prepare(`
    SELECT * FROM companies
    WHERE (? IS NULL OR country = ?)
    ORDER BY country, priority DESC, CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank, id
  `).all(country, country);

  // Concurrency controls pressure, not funnel size: every company is processed.
  const concurrency = Math.max(1, Number(process.env.SOURCE_REGISTRY_CONCURRENCY) || 6);
  const ctx = makeHttpCtx();
  const summary = { companies: companies.length, resolved: 0, empty: 0, unresolved: 0 };

  await parallelMap(companies, concurrency, async (row) => {
    const input = { name: row.name };
    if (row.website) input.website = row.website;
    let result;
    try {
      result = await resolveCompany(input, { ctx });
    } catch (err) {
      result = { unresolved: { name: row.name, reason: err?.message || String(err) } };
    }

    if (result.resolved) {
      const r = result.resolved;
      db.prepare(`
        INSERT INTO company_sources
          (company_id, provider, careers_url, api, status, job_count, verified_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(company_id, careers_url) DO UPDATE SET
          provider=excluded.provider,
          api=excluded.api,
          status=excluded.status,
          job_count=excluded.job_count,
          verified_at=excluded.verified_at,
          error=NULL
      `).run(row.id, r.provider || r.vendor || null, r.careers_url, r.api || null, 'live', r.jobCount ?? null, now());
      summary.resolved += 1;
      console.log('resolved ' + row.country + ' ' + row.name + ' -> ' + r.careers_url);
      return;
    }

    const u = result.unresolved || {};
    const empty = Array.isArray(u.emptyBoards) && u.emptyBoards.length > 0;
    if (empty) {
      for (const board of u.emptyBoards) {
        db.prepare(`
          INSERT INTO company_sources
            (company_id, provider, careers_url, api, status, job_count, verified_at, error)
          VALUES (?, ?, ?, NULL, 'empty', 0, ?, ?)
          ON CONFLICT(company_id, careers_url) DO UPDATE SET
            status='empty', job_count=0, verified_at=excluded.verified_at, error=excluded.error
        `).run(row.id, board.vendor || null, board.careers_url, now(), u.reason || null);
      }
      summary.empty += 1;
    } else {
      summary.unresolved += 1;
    }
  });
  return summary;
}

function loadUserPortals() {
  if (!existsSync(USER_PORTALS)) return {};
  try {
    const doc = yaml.load(readFileSync(USER_PORTALS, 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

function dedupeEntries(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = String(row.careers_url || row.api || row.name || '').trim().toLowerCase().replace(/\/+$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function exportPortals(country = null) {
  const catalog = loadCatalog();
  const base = loadUserPortals();
  const db = openRegistryDb();
  const existingCompanies = Array.isArray(base.tracked_companies) ? base.tracked_companies : [];
  const existingBoards = Array.isArray(base.job_boards) ? base.job_boards : [];

  const catalogBoards = (catalog.job_sources || [])
    .filter((s) => countryMatch(s.country, country) && s.provider)
    .map((s) => ({
      name: s.name,
      ...(s.url ? { careers_url: s.url } : {}),
      provider: s.provider,
      enabled: true,
      notes: 'regional source ' + s.id + '; locales=' + sourceLocale(s.country, s.locales).join(','),
      ...(s.channel ? { channel: s.channel } : {}),
    }));

  const resolved = db.prepare(`
    SELECT c.country, c.name, cs.provider, cs.careers_url, cs.api, cs.status
    FROM company_sources cs
    JOIN companies c ON c.id = cs.company_id
    WHERE cs.status IN ('live','empty') AND (? IS NULL OR c.country = ?)
    ORDER BY c.country, c.priority DESC, c.rank, c.name
  `).all(country, country).map((r) => ({
    name: r.name,
    careers_url: r.careers_url,
    ...(r.api ? { api: r.api } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    enabled: true,
    notes: 'source-registry ' + r.country + '; verified=' + r.status,
  }));

  const doc = {
    ...base,
    tracked_companies: dedupeEntries([...existingCompanies, ...resolved]),
    job_boards: dedupeEntries([...existingBoards, ...catalogBoards]),
  };
  mkdirSync(path.dirname(EXPORT_PATH), { recursive: true });
  writeFileSync(EXPORT_PATH, yaml.dump(doc, { lineWidth: 140, noRefs: true, sortKeys: false }), 'utf8');
  return { path: EXPORT_PATH, trackedCompanies: doc.tracked_companies.length, jobBoards: doc.job_boards.length };
}

function status(country = null) {
  const db = openRegistryDb();
  const companies = db.prepare('SELECT country, COUNT(*) AS n, SUM(priority) AS priority FROM companies GROUP BY country ORDER BY country').all();
  const sources = db.prepare('SELECT country, kind, COUNT(*) AS n FROM sources GROUP BY country, kind ORDER BY country, kind').all();
  const memberships = db.prepare(`
    SELECT c.country, cm.source_id, cm.status, COUNT(*) AS n
    FROM company_memberships cm JOIN companies c ON c.id=cm.company_id
    GROUP BY c.country, cm.source_id, cm.status
    ORDER BY c.country, cm.source_id, cm.status
  `).all();
  const resolved = db.prepare(`
    SELECT c.country, cs.status, COUNT(*) AS n
    FROM company_sources cs JOIN companies c ON c.id=cs.company_id
    GROUP BY c.country, cs.status ORDER BY c.country, cs.status
  `).all();
  const out = {
    db: DB_PATH,
    catalog: CATALOG_PATH,
    export: EXPORT_PATH,
    companies: country ? companies.filter((r) => r.country === country) : companies,
    sources: country ? sources.filter((r) => r.country === country || r.country == null) : sources,
    memberships: country ? memberships.filter((r) => r.country === country) : memberships,
    companySources: country ? resolved.filter((r) => r.country === country) : resolved,
  };
  return out;
}

function parseArgs(argv) {
  const cmd = argv[0] || 'status';
  const countryArg = argv.find((v) => v.startsWith('--country='));
  const idx = argv.indexOf('--country');
  const country = String(countryArg ? countryArg.split('=')[1] : (idx >= 0 ? argv[idx + 1] : '')).trim().toUpperCase() || null;
  if (country && !['RU', 'KZ', 'AM', 'UZ'].includes(country)) throw new Error('country must be RU, KZ, AM, or UZ');
  return { cmd, country, json: argv.includes('--json') };
}

async function withRun(action, country, fn) {
  const db = openRegistryDb();
  const info = db.prepare('INSERT INTO registry_runs(started_at, action, country) VALUES (?, ?, ?)').run(now(), action, country);
  try {
    const summary = await fn();
    db.prepare('UPDATE registry_runs SET finished_at=?, ok=1, summary_json=? WHERE id=?')
      .run(now(), JSON.stringify(summary), info.lastInsertRowid);
    return summary;
  } catch (err) {
    db.prepare('UPDATE registry_runs SET finished_at=?, ok=0, error=? WHERE id=?')
      .run(now(), err?.message || String(err), info.lastInsertRowid);
    throw err;
  }
}

async function main() {
  const { cmd, country, json } = parseArgs(process.argv.slice(2));
  if (cmd === 'init') {
    const n = upsertCatalog();
    console.log('source registry initialized: ' + n + ' catalog sources');
    return;
  }
  if (cmd === 'sync') {
    const out = await withRun('sync', country, () => syncDirectories(country));
    if (json) console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === 'verify') {
    const out = await withRun('verify', country, () => verifySources(country));
    if (json) console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === 'resolve') {
    const out = await withRun('resolve', country, () => resolveCompanySources(country));
    if (json) console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === 'export') {
    upsertCatalog();
    const out = exportPortals(country);
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === 'full') {
    const out = {};
    out.sync = await withRun('sync', country, () => syncDirectories(country));
    out.verify = await withRun('verify', country, () => verifySources(country));
    out.resolve = await withRun('resolve', country, () => resolveCompanySources(country));
    out.export = exportPortals(country);
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === 'status') {
    upsertCatalog();
    console.log(JSON.stringify(status(country), null, 2));
    return;
  }
  throw new Error('usage: node source-registry.mjs <init|sync|verify|resolve|export|full|status> [--country RU|KZ|AM|UZ] [--json]');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('source-registry: ' + (err?.message || err));
    process.exit(1);
  });
}
