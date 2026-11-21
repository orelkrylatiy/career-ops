// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// superjob.ru search-page scanner.
// The official API (api.superjob.ru) requires a registered app key, and the
// page's window.APP_STATE holds no vacancy entities (verified 2026-10-21) —
// but every search page ships a schema.org ItemList whose itemListElement
// carries one canonical URL per vacancy. This provider parses that ItemList
// and derives the title from the URL slug (transliterated Russian, lowercase).
// Honest limits: no salary/company/date at list level; titles are slug-derived
// — enough for discovery + title-based ranking, not for evaluation.
// Pagination: ?page=N (1-based), stop on an empty ItemList.

import { fetchTextWithRetry } from './_http.mjs';

const SEARCH = 'https://www.superjob.ru/vacancy/search/';
const TRUSTED_HOST = 'www.superjob.ru';

export const DEFAULT_QUERIES = [
  'frontend',
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
];

/** Extract the schema.org ItemList URLs from a search page (or raw ld+json). */
export function extractSuperjobUrls(html) {
  const scripts = String(html ?? '').match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  );
  if (!scripts) return [];
  const urls = [];
  for (const script of scripts) {
    const raw = script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const block = Array.isArray(json) ? json : [json];
    for (const item of block) {
      if (item?.['@type'] !== 'ItemList') continue;
      for (const el of Array.isArray(item.itemListElement) ? item.itemListElement : []) {
        const url = String(el?.url ?? (typeof el === 'string' ? el : '')).trim();
        if (url) urls.push(url);
      }
    }
  }
  return urls;
}

/** Derive a readable (transliterated) title from a /vakansii/ slug URL. */
export function titleFromSuperjobUrl(url) {
  const m = /\/vakansii\/(.+?)-?(\d+)\.html?$/.exec(String(url ?? ''));
  if (!m) return '';
  const slug = (m[1] || '').replace(/[-_]+/g, ' ').trim();
  return slug;
}

export function parseSuperjobListing(html) {
  const out = [];
  for (const url of extractSuperjobUrls(html)) {
    const title = titleFromSuperjobUrl(url);
    const id = (/(?:-)(\d+)\.html?$/.exec(url) || [])[1] || url;
    if (!title) continue;
    out.push({
      title,
      url,
      company: '',
      location: '',
      externalId: id,
    });
  }
  return out;
}

function searchUrl(query, page) {
  const u = new URL(SEARCH);
  u.searchParams.set('keywords', query);
  if (page > 1) u.searchParams.set('page', String(page));
  if (u.hostname !== TRUSTED_HOST) throw new Error('superjob: internal host mismatch');
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
  id: 'superjob',

  detect(entry) {
    if (entry?.provider === 'superjob') return { url: SEARCH };
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
        const html = await fetchTextWithRetry(ctx, searchUrl(query, page), { redirect: 'error', timeoutMs: 25_000 });
        const parsed = parseSuperjobListing(html);

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
        await sleep(500);
      }
    }

    return jobs;
  },

  dedupKey(job) {
    return job?.externalId ? `superjob:${job.externalId}` : null;
  },
};
