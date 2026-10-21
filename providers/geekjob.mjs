// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// geekjob.ru public JSON search API.
// Endpoint: https://geekjob.ru/json/find/vacancy?text=<query>&page=<N>
// Verified live 2026-10-21: `page` is 1-based, default page size 100, and the
// response carries {page, nextpage, pagecount, documentsCount, data:[...]}.
// List rows carry position/salary/location/jobFormat/company but no posting
// body; vacancies resolve to https://geekjob.ru/vacancy/<id>.
// Row `log.modify` is a human date like "21 октября" (Russian genitive month,
// no year) — the year is resolved against the current date and rolled back
// when the result would land in the future.

import { fetchJsonWithRetry } from './_http.mjs';

const API = 'https://geekjob.ru/json/find/vacancy';
const TRUSTED_HOST = 'geekjob.ru';

export const DEFAULT_QUERIES = [
  'разработчик',
  'программист',
  'software',
  'backend',
  'frontend',
  'fullstack',
  'devops',
  'sre',
  'data engineer',
  'data scientist',
  'аналитик',
  'тестировщик',
  'qa',
  'machine learning',
  'искусственный интеллект',
  'информационная безопасность',
  'кибербезопасность',
  'системный администратор',
  'архитектор',
  'product manager',
  'project manager',
  'tech lead',
  'руководитель разработки',
];

const RU_MONTHS = {
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
};

/** @returns {number} epoch ms, or NaN when the row date is unusable */
export function parseGeekjobDate(value) {
  const m = /^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/.exec(String(value ?? '').trim().toLowerCase());
  if (!m) return NaN;
  const day = Number(m[1]);
  const month = RU_MONTHS[m[2]];
  if (!Number.isInteger(day) || month === undefined) return NaN;
  const now = new Date();
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  let ms = Date.UTC(year, month, day);
  // A board date without a year can never be in the future; roll back once.
  if (ms > Date.now() + 2 * 24 * 60 * 60 * 1000) {
    year -= 1;
    ms = Date.UTC(year, month, day);
  }
  return ms;
}

function descriptionFor(row) {
  const parts = [];
  const salary = String(row?.salary ?? '').trim();
  if (salary) parts.push(salary);
  const f = row?.jobFormat ?? {};
  const flags = [];
  if (f.remote) flags.push('удалённо');
  if (f.relocate) flags.push('возможна релокация');
  if (f.parttime) flags.push('частичная занятость');
  if (f.inhouse) flags.push('офис/inhouse');
  if (flags.length) parts.push(flags.join(', '));
  return parts.join(' · ');
}

export function parseGeekjobResponse(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const out = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const id = String(row.id ?? '').trim();
    const title = String(row.position ?? '').trim();
    if (!title || !id) continue;

    const company = String(row?.company?.name ?? '').trim();
    const location = [row.city, row.country]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .join(', ');

    const postedMs = parseGeekjobDate(row?.log?.modify);
    const description = descriptionFor(row);

    out.push({
      title,
      url: `https://geekjob.ru/vacancy/${encodeURIComponent(id)}`,
      company,
      location,
      ...(Number.isFinite(postedMs) ? { postedAt: postedMs } : {}),
      ...(description ? { description } : {}),
      externalId: id,
    });
  }
  return out;
}

function queriesFor(entry) {
  const raw = Array.isArray(entry?.search_queries) ? entry.search_queries
    : Array.isArray(entry?.queries) ? entry.queries
      : DEFAULT_QUERIES;
  const q = raw.map((v) => String(v ?? '').trim()).filter(Boolean);
  return [...new Set(q)];
}

function apiUrl(query, page) {
  const u = new URL(API);
  u.searchParams.set('text', query);
  u.searchParams.set('page', String(page));
  if (u.hostname !== TRUSTED_HOST) throw new Error('geekjob: internal API host mismatch');
  return u.href;
}

/** @type {Provider} */
export default {
  id: 'geekjob',

  detect(entry) {
    if (entry?.provider === 'geekjob') return { url: API };
    try {
      const u = new URL(entry?.careers_url || entry?.api || '');
      return u.hostname === TRUSTED_HOST ? { url: API } : null;
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
        const json = await fetchJsonWithRetry(ctx, apiUrl(query, page), { redirect: 'error', timeoutMs: 20_000 });
        const parsed = parseGeekjobResponse(json);
        const pageCount = Number(json?.pagecount);

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
        if (Number.isFinite(pageCount) && page > pageCount) break;
        await sleep(250);
      }
    }

    return jobs;
  },

  dedupKey(job) {
    return job?.externalId ? `geekjob:${job.externalId}` : null;
  },
};
