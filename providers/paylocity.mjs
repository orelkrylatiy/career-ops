// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Paylocity provider — reads the public server-rendered recruiting page:
//   https://recruiting.paylocity.com/recruiting/jobs/All/<tenant-guid>/
//
// The page exposes the current job inventory in a window.pageData JSON object.
// No authentication or browser automation is required. The provider is useful
// both for explicit tracked companies and for scan-ats-full.mjs reverse
// discovery using the public tenant corpus already consumed by that scanner.

import { htmlToText } from './_html-to-text.mjs';
import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const PAYLOCITY_HOST = 'recruiting.paylocity.com';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertPaylocityUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`paylocity: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`paylocity: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== PAYLOCITY_HOST) {
    throw new Error(`paylocity: untrusted hostname "${parsed.hostname}" — expected ${PAYLOCITY_HOST}`);
  }
  return url;
}

export function resolvePaylocityGuid(entry) {
  if (typeof entry?.paylocity === 'string' && GUID_RE.test(entry.paylocity.trim())) {
    return entry.paylocity.trim().toLowerCase();
  }
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== PAYLOCITY_HOST) return null;
  const m = parsed.pathname.match(/^\/recruiting\/jobs\/All\/([0-9a-f-]{36})(?:\/|$)/i);
  return m && GUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

function allJobsUrl(guid) {
  return `https://${PAYLOCITY_HOST}/recruiting/jobs/All/${guid}/`;
}

function extractPageData(html) {
  if (typeof html !== 'string') return null;
  const marker = /window\.pageData\s*=\s*/g.exec(html);
  if (!marker) return null;
  let i = marker.index + marker[0].length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const json = html.slice(i, j + 1);
        try { return JSON.parse(json); } catch { return null; }
      }
    }
  }
  return null;
}

function postedAt(value) {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function locationFor(job) {
  const loc = job?.JobLocation || {};
  const city = typeof loc.City === 'string' ? loc.City.trim() : '';
  const state = typeof loc.State === 'string' ? loc.State.trim() : '';
  const place = [city, state].filter(Boolean).join(', ')
    || (typeof job?.LocationName === 'string' ? job.LocationName.trim() : '');
  const remote = job?.IsRemote ? 'Remote' : '';
  return [place, remote].filter(Boolean).join(', ');
}

export function parsePaylocityPage(html, companyName) {
  const data = extractPageData(html);
  if (!data) return null;
  const rows = Array.isArray(data.Jobs) ? data.Jobs : [];
  const jobs = [];
  const seen = new Set();

  for (const row of rows) {
    const id = String(row?.JobId ?? '').trim();
    const title = typeof row?.JobTitle === 'string' ? row.JobTitle.trim() : '';
    if (!id || !title || seen.has(id)) continue;

    const encoded = encodeURIComponent(id);
    const url = `https://${PAYLOCITY_HOST}/recruiting/Jobs/Details/${encoded}`;
    const job = {
      title,
      url,
      company: companyName,
      location: locationFor(row),
    };
    const stamp = postedAt(row?.PublishedDate);
    if (stamp !== undefined) job.postedAt = stamp;
    const description = htmlToText(row?.Description);
    if (description) job.description = description;

    seen.add(id);
    jobs.push(job);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'paylocity',

  detect(entry) {
    const guid = resolvePaylocityGuid(entry);
    return guid ? { url: allJobsUrl(guid) } : null;
  },

  async fetch(entry, ctx) {
    const guid = resolvePaylocityGuid(entry);
    if (!guid) throw new Error(`paylocity: cannot derive tenant GUID for ${entry?.name || 'entry'}`);
    const url = assertPaylocityUrl(allJobsUrl(guid));
    const html = await ctx.fetchText(url, {
      redirect: 'error',
      headers: {
        'user-agent': BROWSER_LIKE_USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
    });
    const jobs = parsePaylocityPage(html, entry?.name || guid);
    if (jobs === null) {
      throw new Error('paylocity: window.pageData JSON not found or could not be parsed');
    }
    return jobs;
  },
};
