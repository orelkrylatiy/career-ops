// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// staff.am Armenia public job listings. No login/API key required for the
// server-rendered category pages. The provider scans several tech categories
// and follows pagination until a page contributes no new job URLs. There is no
// Career-Ops page/result ceiling in a normal scan; ctx.maxPages is honored only
// when a caller (notably verify-portals) explicitly asks for a bounded probe.

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const HOST = 'staff.am';
const DEFAULT_PATHS = [
  '/jobs/software-development',
  '/jobs/data-science',
  '/jobs/information-technologies',
  '/jobs/product-project-management',
];

function visible(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(raw) {
  try {
    const u = new URL(raw, 'https://staff.am');
    return u.protocol === 'https:' && (u.hostname === HOST || u.hostname === 'www.staff.am') ? u.href : null;
  } catch {
    return null;
  }
}

const JOB_LINK_RE = /<a\b[^>]*href=["']((?:\/(?:en|ru|am))?\/jobs\/([^"'/?#]+)\/([^"'?#]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
const COMPANY_LINK_RE = /<a\b[^>]*href=["']((?:\/(?:en|ru|am))?\/company\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/i;
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const HUMAN_DATE_RE = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i;
const MONTHS = new Map([
  ['january',0],['february',1],['march',2],['april',3],['may',4],['june',5],
  ['july',6],['august',7],['september',8],['october',9],['november',10],['december',11],
]);

function parseDate(text) {
  const iso = ISO_DATE_RE.exec(text);
  if (iso) {
    const ms = Date.parse(iso[1]);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const m = HUMAN_DATE_RE.exec(text);
  if (!m) return undefined;
  const month = MONTHS.get(m[2].toLowerCase());
  if (month == null) return undefined;
  return Date.UTC(Number(m[3]), month, Number(m[1]));
}

function locationFromWindow(text) {
  const cleaned = visible(text);
  const candidates = [
    'Yerevan', 'Gyumri', 'Vanadzor', 'Ashtarak', 'Abovyan', 'Armenia', 'Remote',
    'Երևան', 'Գյումրի', 'Վանաձոր', 'Աշտարակ', 'Աբովյան',
  ];
  const found = candidates.filter((x) => cleaned.toLowerCase().includes(x.toLowerCase()));
  return [...new Set(found)].join(', ');
}

export function parseStaffAmListing(html, pageUrl = 'https://staff.am/jobs/software-development') {
  const source = String(html ?? '');
  const matches = [...source.matchAll(JOB_LINK_RE)];
  const out = [];
  const seen = new Set();

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const url = absolute(m[1]);
    const title = visible(m[4]);
    if (!url || !title || /^(view more|more|подробнее|դիտել ավելին)$/i.test(title)) continue;
    if (seen.has(url)) continue;

    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(source.length, start + 5000);
    const window = source.slice(start, end);

    const cm = COMPANY_LINK_RE.exec(window);
    let company = cm ? visible(cm[2]) : '';
    if (!company) {
      // Some listing card variants render company name as plain text beside a
      // verified badge. Take the first short text line after the title, but
      // never fabricate if the structure is ambiguous.
      const plain = visible(window).split(/\s{2,}|\n/).map((x) => x.trim()).filter(Boolean);
      company = plain.find((x) => x.length >= 2 && x.length <= 120
        && !/^(new|featured|full time|remote|yerevan|view more|\d+)/i.test(x)) || '';
    }

    const postedAt = parseDate(visible(window));
    const location = locationFromWindow(window);
    seen.add(url);
    out.push({
      title,
      url,
      company,
      location,
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }

  if (out.length === 0 && /\/jobs\/(?:software-development|data-science)\//i.test(source)) {
    throw new Error('staffam: page still contains job-detail links but parser produced zero jobs');
  }
  return out;
}

function pathsFor(entry) {
  const paths = Array.isArray(entry?.paths) ? entry.paths : DEFAULT_PATHS;
  return [...new Set(paths.map((p) => String(p || '').trim()).filter((p) => /^\/jobs\/[a-z0-9-]+$/i.test(p)))];
}

function pageUrl(pathname, page, locale) {
  const prefix = locale && locale !== 'en' ? '/' + locale : '';
  const u = new URL(prefix + pathname, 'https://staff.am');
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

/** @type {Provider} */
export default {
  id: 'staffam',

  detect(entry) {
    if (entry?.provider === 'staffam') return { url: 'https://staff.am/jobs/software-development' };
    try {
      const u = new URL(entry?.careers_url || '');
      return /(^|\.)staff\.am$/i.test(u.hostname) ? { url: u.href } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const jobs = [];
    const seen = new Set();
    const locale = ['en', 'ru', 'am'].includes(entry?.locale) ? entry.locale : 'en';
    const maxPages = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;

    for (const pathname of pathsFor(entry)) {
      for (let page = 1; page <= maxPages; page++) {
        const url = pageUrl(pathname, page, locale);
        const html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
        const parsed = parseStaffAmListing(html, url);
        let added = 0;
        for (const job of parsed) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
          added += 1;
        }
        if (parsed.length === 0 || added === 0) break;
      }
    }
    return jobs;
  },
};
