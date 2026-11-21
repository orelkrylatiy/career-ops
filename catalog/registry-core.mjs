// @ts-check
// Pure parsers/helpers for the regional source registry. Network and DB side
// effects live in source-registry.mjs so these rules stay cheap to unit-test.

import { decodeEntities } from '../providers/_html-entities.mjs';

export function text(fragment) {
  return decodeEntities(String(fragment ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function absoluteUrl(raw, base) {
  try {
    const u = new URL(String(raw ?? ''), base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function cells(row) {
  return [...String(row).matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
}

function firstHref(fragment, base) {
  const m = String(fragment ?? '').match(/<a\b[^>]*href=["']([^"']+)["']/i);
  return m ? absoluteUrl(decodeEntities(m[1]), base) : null;
}

function cleanCompanyName(name) {
  return String(name ?? '').replace(/^["«“”]+|["»“”]+$/g, '').replace(/\s+/g, ' ').trim();
}

function plausibleCompany(name) {
  const n = cleanCompanyName(name);
  if (n.length < 2 || n.length > 220) return false;
  if (/^(home|search|show all|company name|director|address|telephone|email|next|previous|главная|поиск|компания|наименование компании)$/i.test(n)) return false;
  return /[\p{L}\p{N}]/u.test(n);
}

// CNews500 table: rank, previous rank, company, revenue.
// We retain every ranked row. rank <= 200 is priority metadata, never a ceiling.
export function parseCnews500(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const row of String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cs = cells(row[1]);
    if (cs.length < 3) continue;
    const rank = Number(text(cs[0]).match(/^\d{1,4}$/)?.[0]);
    const name = cleanCompanyName(text(cs[2]));
    if (!Number.isInteger(rank) || rank < 1 || !plausibleCompany(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, rank, priority: rank <= 200, website: firstHref(cs[2], baseUrl), externalId: String(rank), status: 'listed' });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// Astana Hub register: certificate/date/validity/BIN/status/name.
export function parseAstanaHubParticipants(html) {
  const out = [];
  for (const row of String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cs = cells(row[1]);
    if (cs.length < 6) continue;
    const certificate = text(cs[0]);
    const issuedAt = text(cs[1]);
    const validUntil = text(cs[2]);
    const bin = text(cs[3]);
    const status = text(cs[4]);
    const name = cleanCompanyName(text(cs[5]));
    if (!/^\d+$/.test(certificate) || !plausibleCompany(name)) continue;
    out.push({ name, externalId: bin || certificate, certificate, issuedAt, validUntil, status });
  }
  return out;
}

// Astana Hub broad company directory. Company detail anchors are the identity
// spine. The parser intentionally errs toward inclusion; later ATS/health
// verification determines whether the company yields a usable source.
export function parseAstanaHubCompanies(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = absoluteUrl(decodeEntities(m[1]), baseUrl);
    const name = cleanCompanyName(text(m[2]));
    if (!href || !plausibleCompany(name)) continue;
    let u;
    try { u = new URL(href); } catch { continue; }
    if (!/(?:^|\.)astanahub\.com$/i.test(u.hostname)) continue;
    if (/\/(?:event|news|program|course|vacancy|registration|service)(?:\/|$)/i.test(u.pathname)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, directoryUrl: href, status: 'listed' });
  }
  return out;
}

// EIF IT Guide uses old server-rendered detail anchors on index.php.
export function parseEifItGuide(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']*?(?:index\.php)?\?[^"']*id=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = cleanCompanyName(text(m[2]));
    if (!plausibleCompany(name)) continue;
    const low = name.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push({ name, directoryUrl: absoluteUrl(decodeEntities(m[1]), baseUrl), status: 'listed' });
  }
  return out;
}

// IT Park Uzbekistan unified register: number/legal name/TIN/address/email/date.
export function parseItParkResidents(html) {
  const out = [];
  for (const row of String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cs = cells(row[1]);
    if (cs.length < 5) continue;
    const rowNumber = text(cs[0]);
    const name = cleanCompanyName(text(cs[1]));
    const tin = text(cs[2]);
    const address = text(cs[3]);
    const joinedAt = text(cs[cs.length - 1]);
    if (!/^\d+$/.test(rowNumber) || !plausibleCompany(name)) continue;
    out.push({ name, externalId: tin || rowNumber, tin, address, joinedAt, status: 'listed' });
  }
  return out;
}

export const DIRECTORY_PARSERS = {
  cnews500: parseCnews500,
  'astanahub-participants': parseAstanaHubParticipants,
  'astanahub-companies': parseAstanaHubCompanies,
  'eif-it-guide': parseEifItGuide,
  'itpark-residents': parseItParkResidents,
};

export function normalizeCompanyKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[«»"'“”„]/g, '')
    // JS \b is ASCII-centric and does not form useful word boundaries around
    // Cyrillic legal forms such as ООО/ТОО. Use Unicode letter/number
    // boundaries explicitly so regional company identity really collapses.
    .replace(/(^|[^\p{L}\p{N}])(?:ооо|зао|оао|пао|тоо|ао|llc|ltd|inc|cjsc|ojsc|jsc|masuliyati cheklangan jamiyat)(?=[^\p{L}\p{N}]|$)/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sourceLocale(country, locales = []) {
  const fallback = { RU: ['ru', 'en'], KZ: ['ru', 'kk', 'en'], AM: ['en', 'hy', 'ru'], UZ: ['uz', 'ru', 'en'] };
  return Array.isArray(locales) && locales.length ? locales : (fallback[country] || ['en']);
}

export function healthKind(status) {
  if (status >= 200 && status < 400) return 'reachable';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'server';
  return 'http_error';
}
