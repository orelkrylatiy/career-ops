// Pure heuristics for discovering official/company career pages.
// Discovery is deliberately evidence-preserving: a URL is a candidate until a
// live response and career vocabulary/ATS signature verify it.

import { decodeEntities } from '../providers/_html-entities.mjs';

const SOCIAL_OR_DIRECTORY_HOSTS = [
  'facebook.com', 'instagram.com', 'linkedin.com', 't.me', 'telegram.me',
  'vk.com', 'youtube.com', 'youtu.be', 'x.com', 'twitter.com',
  'cnews.ru', 'astanahub.com', 'itguide.eif.am', 'eif.am', 'it-park.uz',
  'hh.ru', 'hh.kz', 'hh.uz', 'staff.am', 'careercenter.am', 'ishkop.uz',
];

const CAREER_TEXT_RE = /(?:career|careers|jobs?|vacanc(?:y|ies)|work with us|join us|join our team|we'?re hiring|hiring|карьер|ваканси|работ[аы]|работать у нас|присоединяйтесь|աշխատանք|թափուր|karera|vakansiya|vakansiyalar|bo['’]?sh ish)/iu;
const CAREER_PATH_RE = /(?:^|\/)(?:career|careers|jobs?|vacancy|vacancies|work|join-us|join|hiring|career-center|rabota|vakansii|vakansiya|karera)(?:\/|$|[-_])/iu;

const ATS_HOST_RE = /(?:greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|myworkdayjobs\.com|bamboohr\.com|teamtailor\.com|smartrecruiters\.com|jobvite\.com|recruitee\.com|personio\.(?:de|com)|oraclecloud\.com)$/i;

function visible(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalUrl(raw, base) {
  try {
    const u = new URL(decodeEntities(String(raw ?? '')), base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function hostBlockedAsOfficial(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return SOCIAL_OR_DIRECTORY_HOSTS.some((x) => h === x || h.endsWith('.' + x));
}

export function extractCareerLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const baseHost = (() => { try { return new URL(baseUrl).hostname; } catch { return ''; } })();

  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = canonicalUrl(m[1], baseUrl);
    if (!url) continue;
    const text = visible(m[2]);
    const u = new URL(url);
    const isAts = ATS_HOST_RE.test(u.hostname);
    const signal = CAREER_TEXT_RE.test(text) || CAREER_PATH_RE.test(u.pathname) || isAts;
    if (!signal) continue;

    const key = url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url,
      text,
      isAts,
      sameHost: u.hostname === baseHost || u.hostname.endsWith('.' + baseHost) || baseHost.endsWith('.' + u.hostname),
      score: (isAts ? 8 : 0)
        + (CAREER_PATH_RE.test(u.pathname) ? 5 : 0)
        + (CAREER_TEXT_RE.test(text) ? 4 : 0)
        + ((u.hostname === baseHost) ? 2 : 0),
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

export function extractExternalWebsiteCandidates(html, directoryUrl) {
  let directoryHost = '';
  try { directoryHost = new URL(directoryUrl).hostname.toLowerCase(); } catch {}
  const out = [];
  const seen = new Set();

  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = canonicalUrl(m[1], directoryUrl);
    if (!url) continue;
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === directoryHost || host.endsWith('.' + directoryHost)) continue;
    if (hostBlockedAsOfficial(host)) continue;
    const label = visible(m[2]);
    const key = host.replace(/^www\./, '');
    if (seen.has(key)) continue;
    seen.add(key);

    // Prefer an obvious website/homepage link, then shallow external links.
    const websiteSignal = /(?:website|web site|сайт|կայք|veb[- ]?sayt)/iu.test(label);
    const depth = u.pathname.split('/').filter(Boolean).length;
    out.push({
      url,
      label,
      score: (websiteSignal ? 8 : 0) + (depth <= 1 ? 3 : 0) + (u.protocol === 'https:' ? 1 : 0),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function commonCareerCandidates(website) {
  let origin;
  try {
    const u = new URL(website);
    if (!/^https?:$/.test(u.protocol)) return [];
    origin = u.origin;
  } catch {
    return [];
  }
  const paths = [
    '/careers', '/career', '/jobs', '/vacancies', '/vacancy',
    '/work', '/join-us', '/hiring', '/career/vacancies',
    '/ru/career', '/ru/vacancies', '/ru/jobs',
    '/en/careers', '/en/jobs',
  ];
  return paths.map((p) => origin + p);
}

export function careerPageEvidence(html, url) {
  const body = visible(html).slice(0, 20000);
  let path = '';
  let host = '';
  try {
    const u = new URL(url);
    path = u.pathname;
    host = u.hostname;
  } catch {}
  const links = extractCareerLinks(html, url);
  const score = (CAREER_TEXT_RE.test(body) ? 3 : 0)
    + (CAREER_PATH_RE.test(path) ? 4 : 0)
    + (ATS_HOST_RE.test(host) ? 8 : 0)
    + Math.min(4, links.length);
  return { verified: score >= 5, score, links };
}

export function looksLikeKnownAts(url) {
  try { return ATS_HOST_RE.test(new URL(url).hostname); } catch { return false; }
}
