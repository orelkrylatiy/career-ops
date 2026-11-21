/**
 * profile-stats.mjs — per-direction stats on top of stats.mjs's contract.
 *
 * stats.mjs binds its default file paths to ONE data root at import time;
 * directions each have their own root, so everything here passes explicit
 * file paths into computeAllStats(). The aggregation here is the number the
 * Telegram bot and `profile.mjs stats` show: sum the trackers, recompute the
 * funnel rates from the sums (never average percentages), degrade to nulls
 * for directions with no data yet.
 *
 * No CLI tail — imported by profile.mjs and tg-bot.mjs.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { computeAllStats } from '../stats.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';

/** Map a direction data root to the exact file set computeAllStats reads. */
export function directionStatsFiles(root) {
  return {
    appsFile: join(root, 'data', 'applications.md'),
    scanHistoryFile: join(root, 'data', 'scan-history.tsv'),
    followupsFile: join(root, 'data', 'follow-ups.md'),
    scanRunsFile: join(root, 'data', 'scan-runs.tsv'),
    statusLogFile: join(root, 'data', 'status-log.tsv'),
    portalsFile: join(root, 'portals.yml'),
    portalHealthFile: join(root, 'data', 'portal-health.tsv'),
  };
}

/** Full stats.mjs contract for one direction root; missing tracker → null (fresh direction). */
export function computeDirectionStats(root) {
  const files = directionStatsFiles(root);
  if (!existsSync(files.appsFile)) return null;
  return computeAllStats(files);
}

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (part, total) => (total > 0 ? round1((part / total) * 100) : 0);

const FUNNEL_KEYS = ['everApplied', 'everResponded', 'everInterview', 'everOffer'];

/**
 * Aggregate a profile's directions into one roll-up. Input entries are
 * computeAllStats() results (null allowed for empty directions). Tracker
 * byStatus counts and funnel ever* counters are summed; rates are recomputed
 * from the sums; per-direction rows are kept for the breakdown view.
 */
export function aggregateProfileStats(directionEntries) {
  const byStatus = {};
  const funnel = Object.fromEntries(FUNNEL_KEYS.map((k) => [k, 0]));
  let total = 0;
  let activeApps = 0;
  let withData = 0;
  for (const entry of directionEntries) {
    if (!entry?.tracker) continue;
    withData++;
    total += entry.tracker.total ?? 0;
    activeApps += entry.tracker.activeApps ?? 0;
    for (const [status, count] of Object.entries(entry.tracker.byStatus ?? {})) {
      byStatus[status] = (byStatus[status] ?? 0) + count;
    }
    for (const key of FUNNEL_KEYS) {
      funnel[key] += entry.funnel?.[key] ?? 0;
    }
  }
  return {
    directions: directionEntries.length,
    directionsWithData: withData,
    tracker: withData ? {
      total,
      activeApps,
      byStatus,
      avgScore: null, // averaging averages across roots is a lie; per-direction detail keeps the real one
    } : null,
    funnel: withData ? {
      ...funnel,
      responseRate: pct(funnel.everResponded, funnel.everApplied),
      interviewRate: pct(funnel.everInterview, funnel.everApplied),
      offerRate: pct(funnel.everOffer, funnel.everApplied),
      smallSample: funnel.everApplied < 10,
    } : null,
  };
}

/**
 * Most recent tracker rows across a profile's directions, newest first.
 * Each row is tagged with its direction id so the bot can show "which
 * direction heard back". Rows without a parseable date sort last.
 */
export function readProfileRecentRows(directionRootsById, limit = 8) {
  const rows = [];
  for (const [directionId, root] of Object.entries(directionRootsById)) {
    const file = join(root, 'data', 'applications.md');
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf-8').replace(/\r/g, '').split('\n');
    const colmap = resolveColumns(lines);
    for (const line of lines) {
      const row = parseTrackerRow(line, colmap);
      if (!row) continue;
      rows.push({
        direction: directionId,
        num: row.num,
        date: row.date,
        company: row.company,
        role: row.role,
        status: row.status,
      });
    }
  }
  rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return rows.slice(0, limit);
}
