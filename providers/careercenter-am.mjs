// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// CareerCenter.am public Armenia listings. Server-rendered list pages expose
// stable /<locale>/jobs/<slug> detail URLs. Normal scans walk pages until no
// new detail URLs appear; no Career-Ops result/page ceiling is imposed.

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const HOST = 'careercenter.am';
const BASE = 'https://careercenter.am/en/jobs?status=all&view=list';

function visible(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(raw) {
  try {
    const u = new URL(raw, 'https://careercenter.am');
    return u.protocol === 'https:' && u.hostname === HOST ? u.href : null;
  } catch {
    return null;
  }
}

const JOB_LINK_RE = /<a\b[^>]*href=["']((?:\/(?:en|ru|hy))?\/jobs\/([^"'/?#]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
const DATE_RE = /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i;
const MONTH = {
  jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
};

function parseDate(value) {
  const m = DATE_RE.exec(value);
  if (!m) return undefined;
  const key = m[2].slice(0,3).toLowerCase();
  const month = MONTH[key];
  return month == null ? undefined : Date.UTC(Number(m[3]), month, Number(m[1]));
}

function companyFromWindow(fragment) {
  // Company detail links vary; prefer their visible anchor text when present.
  const linked = String(fragment).match(/<a\b[^>]*href=["'][^"']*\/(?:companies|company)\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i);
  if (linked) return visible(linked[1]);

  const txt = visible(fragment);
  // On the list view company is rendered directly after the title and before
  // the date. Remove date/tags and keep a conservative short prefix.
  const beforeDate = txt.split(DATE_RE)[0].trim();
  if (beforeDate && beforeDate.length <= 180) return beforeDate;
  return '';
}

export function parseCareerCenterListing(html) {
  const source = String(html ?? '');
  const matches = [...source.matchAll(JOB_LINK_RE)];
  const out = [];
  const seen = new Set();

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const url = absolute(m[1]);
    const title = visible(m[3]);
    if (!url || !title) continue;
    // /en/jobs itself or category/navigation labels are not detail pages.
    if (m[2] === 'jobs' || /^(jobs|all jobs|работа|вакансии)$/i.test(title)) continue;
    if (seen.has(url)) continue;

    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(source.length, start + 4000);
    const window = source.slice(start, end);
    const postedAt = parseDate(visible(window));
    const company = companyFromWindow(window);
    const location = /Yerevan|Երևան|Ереван/i.test(visible(window)) ? 'Yerevan, Armenia' : 'Armenia';

    seen.add(url);
    out.push({ title, url, company, location, ...(postedAt !== undefined ? { postedAt } : {}) });
  }

  if (out.length === 0 && /\/en\/jobs\/[a-z0-9-]+/i.test(source)) {
    throw new Error('careercenter-am: page still contains job links but parser produced zero jobs');
  }
  return out;
}

function listUrl(page, locale) {
  const u = new URL(`https://careercenter.am/${locale}/jobs`);
  u.searchParams.set('status', 'all');
  u.searchParams.set('view', 'list');
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

/** @type {Provider} */
export default {
  id: 'careercenter-am',

  detect(entry) {
    if (entry?.provider === 'careercenter-am') return { url: BASE };
    try {
      const u = new URL(entry?.careers_url || '');
      return u.hostname === HOST ? { url: u.href } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const locale = ['en', 'ru', 'hy'].includes(entry?.locale) ? entry.locale : 'en';
    const jobs = [];
    const seen = new Set();
    const maxPages = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;

    for (let page = 1; page <= maxPages; page++) {
      const url = listUrl(page, locale);
      const html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
      const parsed = parseCareerCenterListing(html);
      let added = 0;
      for (const job of parsed) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
        added += 1;
      }
      if (parsed.length === 0 || added === 0) break;
    }
    return jobs;
  },
};
