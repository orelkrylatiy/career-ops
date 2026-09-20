// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Работа России / trudvsem.ru official open-data API.
// Docs: http://opendata.trudvsem.ru/api
//
// The API itself limits one page to 100 records and one query window to 10k.
// Career-Ops adds NO result/page ceiling of its own in normal scans: each query
// walks until the API says there is nothing left (or total is reached).
// verify-portals may pass ctx.maxPages=1 for a health probe; that is a probe
// optimization, not a discovery limit.

import { fetchJsonWithRetry } from './_http.mjs';

const API = 'http://opendata.trudvsem.ru/api/v1/vacancies';
const TRUSTED_HOST = 'opendata.trudvsem.ru';
const PAGE_SIZE = 100;

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

function safeHttpUrl(value) {
  try {
    const u = new URL(String(value ?? ''));
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function valueAt(obj, ...keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function addressText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  const rows = Array.isArray(v) ? v : (Array.isArray(v.address) ? v.address : [v.address ?? v]);
  return rows
    .map((x) => typeof x === 'string' ? x : [x?.location, x?.street, x?.house].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');
}

export function parseTrudvsemResponse(json) {
  const raw = json?.results?.vacancies;
  const rows = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];

  for (const wrapper of rows) {
    const v = wrapper?.vacancy ?? wrapper;
    if (!v || typeof v !== 'object') continue;

    const id = String(valueAt(v, 'id', 'vacancy-id', 'vacancyId') ?? '').trim();
    const title = String(valueAt(v, 'job-name', 'job_name', 'name', 'title', 'profession') ?? '').trim();
    if (!title) continue;

    const company = String(
      valueAt(v?.company, 'name', 'company_name')
      ?? valueAt(v, 'company_name', 'companyName')
      ?? ''
    ).trim();

    const region = String(valueAt(v?.region, 'name', 'regionName') ?? '').trim();
    const address = addressText(v?.addresses ?? v?.address);
    const location = [region, address].filter(Boolean).join(' — ');

    const explicitUrl = safeHttpUrl(valueAt(v, 'vac_url', 'vacancyUrl', 'url'));
    const companyCode = String(valueAt(v?.company, 'companycode', 'companyCode', 'code') ?? '').trim();
    const url = explicitUrl
      || (id && companyCode ? `https://trudvsem.ru/vacancy/card/${encodeURIComponent(companyCode)}/${encodeURIComponent(id)}` : null)
      || (id ? `https://trudvsem.ru/vacancy/card/${encodeURIComponent(id)}` : null);
    if (!url) continue;

    const postedRaw = valueAt(v, 'creation-date', 'creationDate', 'date', 'modified');
    const postedMs = postedRaw ? Date.parse(String(postedRaw)) : NaN;
    const description = String(valueAt(v, 'duty', 'requirement', 'additional_requirements') ?? '').trim();

    out.push({
      title,
      url,
      company,
      location,
      ...(Number.isFinite(postedMs) ? { postedAt: postedMs } : {}),
      ...(description ? { description } : {}),
      ...(id ? { externalId: id } : {}),
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

function apiUrl(query, offset) {
  const u = new URL(API);
  u.searchParams.set('offset', String(offset));
  u.searchParams.set('limit', String(PAGE_SIZE));
  if (query) u.searchParams.set('text', query);
  if (u.hostname !== TRUSTED_HOST) throw new Error('trudvsem: internal API host mismatch');
  return u.href;
}

/** @type {Provider} */
export default {
  id: 'trudvsem',

  detect(entry) {
    if (entry?.provider === 'trudvsem') return { url: API };
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

    for (const query of queriesFor(entry)) {
      let offset = 1;
      let pages = 0;

      while (pages < maxPages) {
        const url = apiUrl(query, offset);
        const json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
        const parsed = parseTrudvsemResponse(json);
        const total = Number(json?.meta?.total);

        let newCount = 0;
        for (const job of parsed) {
          const key = job.externalId || job.url;
          if (seen.has(key)) continue;
          seen.add(key);
          jobs.push(job);
          newCount += 1;
        }

        pages += 1;
        if (parsed.length === 0 || newCount === 0) break;
        if (Number.isFinite(total) && offset * PAGE_SIZE >= total) break;

        // Official docs call this parameter "offset" but examples start from 1
        // with page-sized responses; incrementing one page at a time is the
        // public documented traversal.
        offset += 1;
      }
    }

    return jobs;
  },

  dedupKey(job) {
    return job?.externalId ? `trudvsem:${job.externalId}` : null;
  },
};
