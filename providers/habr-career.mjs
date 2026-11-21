// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// career.habr.com (Хабр Карьера) search-page state parser.
// The board has no open REST API (OAuth-gated), but the SSR search page embeds
// its full application state in a `<script type="application/json">` blob:
// state.vacancies.list[] carries id, href, title, remoteWork, publishedDate
// and company. Verified live 2026-10-21; `page` is 1-based via ?page=N.
// Note: this scans vacancies only — applying on Habr still requires an OAuth
// session, so hits are discovery, not applications.

import { fetchTextWithRetry } from './_http.mjs';

const BASE = 'https://career.habr.com';
const SEARCH = BASE + '/vacancies';
const TRUSTED_HOST = 'career.habr.com';

export const DEFAULT_QUERIES = [
  'frontend',
  'frontend разработчик',
  'react',
  'backend',
  'fullstack',
  'nodejs',
  'ai',
  'llm',
  'machine learning',
  'data engineer',
  'devops',
  'разработчик',
  'программист',
];

/** Extract the state blob containing the vacancy list from a search page. */
export function extractHabrState(html) {
  const scripts = String(html ?? '').match(
    /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
  );
  if (!scripts) return null;
  for (const script of scripts) {
    const raw = script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const list = json?.vacancies?.list;
    if (Array.isArray(list)) return json;
  }
  return null;
}

export function parseHabrState(state) {
  const rows = Array.isArray(state?.vacancies?.list) ? state.vacancies.list : [];
  const out = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const id = String(row.id ?? '').trim();
    const title = String(row.title ?? '').trim();
    const href = String(row.href ?? '').trim();
    if (!title || !id || !href) continue;

    const companyRaw = row?.company;
    const company = String(
      (typeof companyRaw === 'object' && companyRaw !== null
        ? companyRaw.title ?? companyRaw.alias_name
        : companyRaw) ?? '',
    ).trim();

    const locationRaw = row.location;
    const location = typeof locationRaw === 'object' && locationRaw !== null
      ? String(locationRaw.title ?? '').trim()
      : String(locationRaw ?? '').trim();

    const postedMs = Date.parse(String(row?.publishedDate?.date ?? ''));

    const parts = [];
    if (row.remoteWork) parts.push('удалённо');
    const level = String(row?.salaryQualification?.title ?? '').trim();
    if (level) parts.push(`грейд: ${level}`);
    const description = parts.join(' · ');

    out.push({
      title,
      url: /^https?:/.test(href) ? href : BASE + href,
      company,
      location,
      ...(Number.isFinite(postedMs) ? { postedAt: postedMs } : {}),
      ...(description ? { description } : {}),
      externalId: id,
    });
  }
  return out;
}

function searchUrl(query, page) {
  const u = new URL(SEARCH);
  u.searchParams.set('q', query);
  u.searchParams.set('page', String(page));
  if (u.hostname !== TRUSTED_HOST) throw new Error('habr-career: internal host mismatch');
  return u.href;
}

function queriesFor(entry) {
  const raw = Array.isArray(entry?.search_queries) ? entry.search_queries
    : Array.isArray(entry?.queries) ? entry.queries
      : DEFAULT_QUERIES;
  const q = raw.map((v) => String(v ?? '').trim()).filter(Boolean);
  return [...new Set(q)];
}

/** @type {Provider} */
export default {
  id: 'habr-career',

  detect(entry) {
    if (entry?.provider === 'habr-career') return { url: SEARCH };
    try {
      const u = new URL(entry?.careers_url || entry?.api || '');
      return u.hostname === TRUSTED_HOST ? { url: SEARCH } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const jobs = [];
    const seen = new Set();
    const maxPages = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const sleep = (ms) => (ctx?.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));

    for (const query of queriesFor(entry)) {
      let page = 1;

      while (page <= maxPages) {
        const html = await fetchTextWithRetry(ctx, searchUrl(query, page), { redirect: 'error', timeoutMs: 20_000 });
        const state = extractHabrState(html);
        const parsed = state ? parseHabrState(state) : [];

        let newCount = 0;
        for (const job of parsed) {
          const key = job.externalId || job.url;
          if (seen.has(key)) continue;
          seen.add(key);
          jobs.push(job);
          newCount += 1;
        }

        page += 1;
        if (parsed.length === 0 || newCount === 0) break;
        await sleep(400);
      }
    }

    return jobs;
  },

  dedupKey(job) {
    return job?.externalId ? `habr:${job.externalId}` : null;
  },
};
