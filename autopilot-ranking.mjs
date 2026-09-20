#!/usr/bin/env node
// autopilot-ranking.mjs — soft priority scoring for the wide-funnel worker.
//
// This module NEVER rejects a job. Hard stops belong to the queue ingestion
// layer and are intentionally limited to structural impossibility, exact
// duplicate/already-applied records, and explicit user blacklists.

import { compileKeyword, compilePositiveKeyword } from './title-keywords.mjs';

const REMOTE_RE = /\b(remote|worldwide|anywhere|distributed|work from home|wfh|удал[её]н|дистанц)\b/i;
const ONSITE_RE = /\b(hybrid|onsite|on-site|office[- ]based|in office|гибрид|офис)\b/i;

function strings(value) {
  return (Array.isArray(value) ? value : [])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

function hostname(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; }
}

function includesToken(text, token) {
  return String(text || '').toLowerCase().includes(String(token || '').toLowerCase());
}

function postingAgeDays(raw, nowMs) {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 86_400_000) : null;
}

/**
 * Return an explainable 0..100 priority.
 *
 * Preferences such as title keywords, remote-only and blocked locations are
 * deliberately penalties/boosts only. They must never decide queue admission.
 */
export function scoreJob(job, { titleFilter = {}, profile = {}, nowMs = Date.now() } = {}) {
  let priority = 50;
  const reasons = [];
  const title = String(job?.title || '');
  const location = String(job?.location || '');
  const lowerTitle = title.toLowerCase();

  const positive = strings(titleFilter.positive);
  const negative = strings(titleFilter.negative);
  const positiveHits = positive.filter((k) => compilePositiveKeyword(k.toLowerCase())(lowerTitle));
  const negativeHits = negative.filter((k) => compileKeyword(k.toLowerCase())(lowerTitle));

  if (positiveHits.length) {
    const boost = Math.min(30, 20 + (positiveHits.length - 1) * 3);
    priority += boost;
    reasons.push(`title_match:+${boost}:${positiveHits.slice(0, 3).join(',')}`);
  } else if (positive.length) {
    priority -= 5;
    reasons.push('title_no_match:-5');
  }

  if (negativeHits.length) {
    const penalty = Math.min(24, negativeHits.length * 8);
    priority -= penalty;
    reasons.push(`title_negative:-${penalty}:${negativeHits.slice(0, 3).join(',')}`);
  }

  const locationProfile = profile?.location && typeof profile.location === 'object'
    ? profile.location
    : {};
  const homeTokens = [locationProfile.country, locationProfile.city]
    .filter((v) => typeof v === 'string' && v.trim());
  const homeHits = homeTokens.filter((v) => includesToken(location, v));
  if (homeHits.length) {
    const boost = Math.min(20, homeHits.length * 10);
    priority += boost;
    reasons.push(`home_location:+${boost}:${homeHits.join(',')}`);
  }

  if (REMOTE_RE.test(`${title} ${location}`)) {
    priority += 10;
    reasons.push('remote:+10');
  }

  const ap = profile?.autopilot && typeof profile.autopilot === 'object' ? profile.autopilot : {};
  if (ap.remote_only === true && ONSITE_RE.test(location)) {
    priority -= 12;
    reasons.push('remote_preference_conflict:-12');
  }

  const blocked = strings(ap.blocked_locations).filter((token) => includesToken(location, token));
  if (blocked.length) {
    const penalty = Math.min(20, blocked.length * 10);
    priority -= penalty;
    reasons.push(`location_deprioritized:-${penalty}:${blocked.slice(0, 2).join(',')}`);
  }

  const priorityLocations = strings(ap.priority_locations).filter((token) => includesToken(location, token));
  if (priorityLocations.length) {
    priority += 15;
    reasons.push(`priority_location:+15:${priorityLocations.slice(0, 2).join(',')}`);
  }

  const host = hostname(job?.url);
  const prioritySources = strings(ap.priority_sources)
    .map((v) => v.toLowerCase().replace(/^\.+|\.+$/g, ''))
    .filter((token) => token && (host === token || host.endsWith(`.${token}`)));
  if (prioritySources.length) {
    priority += 15;
    reasons.push(`priority_source:+15:${prioritySources[0]}`);
  }

  const days = postingAgeDays(job?.posted || job?.postedAt || job?.posted_at, nowMs);
  if (days != null) {
    if (days <= 2) {
      priority += 10;
      reasons.push('fresh_2d:+10');
    } else if (days <= 7) {
      priority += 6;
      reasons.push('fresh_7d:+6');
    } else if (days <= 30) {
      priority += 2;
      reasons.push('fresh_30d:+2');
    }
  }

  return {
    priority: Math.max(0, Math.min(100, Math.round(priority))),
    reasons,
    positiveHits,
    negativeHits,
  };
}
