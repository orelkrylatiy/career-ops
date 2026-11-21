// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ish.uz public Uzbekistan vacancy listing. The site server-renders current
// cards and stable job detail URLs whose trailing numeric id is a reliable
// provider-scoped identity.

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const HOST = 'ish.uz';

function visible(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(raw) {
  try {
    const u = new URL(raw, 'https://ish.uz');
    return u.protocol === 'https:' && (u.hostname === HOST || u.hostname === 'www.ish.uz') ? u.href : null;
  } catch {
    return null;
  }
}

// Observed live detail shapes include /oz/jobs-andijan-retail/4490 and
// /jobs-surkhandarya-cash-transactions/4490; locale/slug are presentation,
// numeric suffix is identity.
const JOB_LINK_RE = /<a\b[^>]*href=["']([^"']*\/jobs[^"'?#]*\/(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;

function companyAndLocation(fragment) {
  const text = visible(fragment)
    .replace(/\b(?:Сохранить|Внимание|Полный рабочий день|Неполный рабочий день|Удаленная работа|Стажировка)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Salary is frequently the first line/token group after title. Company then
  // precedes a known Uzbekistan place. Keep parsing conservative: empty values
  // are preferable to inventing an employer.
  const places = ['Ташкент', 'Самарканд', 'Навоий', 'Бухара', 'Андижан', 'Наманган', 'Фергана', 'Нукус', 'Весь Узбекистан', 'Toshkent'];
  let location = '';
  let company = '';
  let idx = -1;
  for (const place of places) {
    const at = text.toLowerCase().indexOf(place.toLowerCase());
    if (at >= 0 && (idx < 0 || at < idx)) { idx = at; location = place; }
  }
  if (idx > 0) {
    const before = text.slice(0, idx)
      .replace(/^\s*[\d\s.,-]+(?:UZS|USD|сум|so['’]?m)?\s*/i, '')
      .trim();
    if (before.length >= 2 && before.length <= 180) company = before;
  }
  return { company, location };
}

export function parseIshUzListing(html) {
  const source = String(html ?? '');
  const matches = [...source.matchAll(JOB_LINK_RE)];
  const out = [];
  const seen = new Set();

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const url = absolute(m[1]);
    const id = m[2];
    const title = visible(m[3]);
    if (!url || !id || !title || seen.has(id)) continue;
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(source.length, start + 2500);
    const meta = companyAndLocation(source.slice(start, end));
    seen.add(id);
    out.push({ title, url, company: meta.company, location: meta.location || 'Uzbekistan', externalId: id });
  }

  if (out.length === 0 && /\/jobs[^"'?#]*\/\d+/i.test(source)) {
    throw new Error('ishuz: page still contains job links but parser produced zero jobs');
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'ishuz',

  detect(entry) {
    if (entry?.provider === 'ishuz') return { url: 'https://ish.uz/ru/jobs' };
    try {
      const u = new URL(entry?.careers_url || '');
      return /(^|\.)ish\.uz$/i.test(u.hostname) ? { url: u.href } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const locale = ['ru', 'oz', 'uz'].includes(entry?.locale) ? entry.locale : 'ru';
    const url = `https://ish.uz/${locale}/jobs`;
    const html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
    return parseIshUzListing(html);
  },

  dedupKey(job) {
    return job?.externalId ? `ishuz:${job.externalId}` : null;
  },
};
