/**
 * profile-registry.mjs — the multi-account registry: profiles → directions.
 *
 * One registry file (profiles.yml, user layer) describes every account this
 * checkout runs. A profile is one person's account, authenticated against
 * Telegram user ids for the bot (several people → several profiles; an admin
 * entry sees every profile). Inside a profile there can be any number of
 * directions — specializations like analyst, designer, react, vue — and each
 * direction is a FULL career-ops data root at
 * {DATA_ROOT}/data/profiles/<profile>/<direction>: its own tracker, reports/,
 * scan history, autopilot.db, config/, portals.yml and browser profile.
 *
 * The isolation needs no per-script work: point CAREER_OPS_ROOT at a
 * direction root and every existing script (stats, scan, autopilot,
 * set-status, …) relocates there — that is what path-resolver.mjs already
 * guarantees. This module only owns the registry itself and the naming rules
 * that keep direction-scoped workers, Playwright sessions and data roots from
 * colliding (docs/AUTOPILOT_ARCHITECTURE.md: parallel workers must use
 * separate sessions/profiles/owner ids — a direction IS a worker identity).
 *
 * Run (via profile.mjs): node profile.mjs list
 */

import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Registry file: CAREER_OPS_PROFILES override > {data root}/profiles.yml (same slot portals.yml uses). */
export function resolveRegistryPath(explicit) {
  if (explicit) return explicit;
  const env = process.env.CAREER_OPS_PROFILES?.trim();
  if (env) return env;
  return join(getCareerOpsRoot(), 'profiles.yml');
}

/**
 * Load and validate the registry. Returns null when the file does not exist
 * (fresh checkout) — callers decide whether that is an error; the bot treats
 * it as "nobody can log in", which is the safe default.
 */
export function loadProfiles({ registryFile } = {}) {
  const file = resolveRegistryPath(registryFile);
  if (!existsSync(file)) return null;
  let registry;
  try {
    registry = yaml.load(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`profiles.yml is not valid YAML: ${err.message}`);
  }
  return normalizeRegistry(registry, file);
}

/** Normalize YAML quirks (missing keys, numeric user ids) and validate shape. Throws on invalid. */
export function normalizeRegistry(registry, source = 'profiles.yml') {
  const bad = (msg) => { throw new Error(`${source}: ${msg}`); };
  if (registry === null || registry === undefined) return { profiles: [] };
  if (typeof registry !== 'object' || Array.isArray(registry)) bad('top level must be a mapping with a "profiles:" list');
  const profiles = registry.profiles ?? [];
  if (!Array.isArray(profiles)) bad('"profiles:" must be a list');

  const seenProfileIds = new Set();
  const seenTelegramIds = new Set();
  const out = [];
  for (const p of profiles) {
    if (typeof p !== 'object' || p === null) bad('every profile must be a mapping');
    if (!isValidId(p.id)) bad(`profile id "${p.id}" is invalid (expected slug like maxim, react-dev)`);
    if (seenProfileIds.has(p.id)) bad(`duplicate profile id "${p.id}"`);
    seenProfileIds.add(p.id);

    const telegram = [];
    for (const t of p.telegram ?? []) {
      if (typeof t !== 'object' || t === null) bad(`profile "${p.id}": every telegram entry must be a mapping`);
      const userId = String(t.user_id ?? '').trim();
      if (!/^\d{1,20}$/.test(userId)) bad(`profile "${p.id}": telegram user_id "${t.user_id}" must be a numeric Telegram id (get it from @userinfobot)`);
      if (seenTelegramIds.has(userId)) bad(`telegram user_id ${userId} appears in more than one place — one Telegram account maps to exactly one profile`);
      seenTelegramIds.add(userId);
      telegram.push({ user_id: userId, name: String(t.name ?? '').trim(), admin: !!t.admin });
    }

    const directions = [];
    const seenDirIds = new Set();
    for (const d of p.directions ?? []) {
      if (typeof d !== 'object' || d === null) bad(`profile "${p.id}": every direction must be a mapping`);
      if (!isValidId(d.id)) bad(`profile "${p.id}": direction id "${d.id}" is invalid (expected slug like analyst, react)`);
      if (seenDirIds.has(d.id)) bad(`profile "${p.id}": duplicate direction id "${d.id}"`);
      seenDirIds.add(d.id);
      directions.push({
        id: d.id,
        name: String(d.name ?? d.id).trim(),
        created: String(d.created ?? '').trim(),
      });
    }

    out.push({
      id: p.id,
      name: String(p.name ?? p.id).trim(),
      telegram,
      directions,
    });
  }
  return { profiles: out };
}

/**
 * Slug shape shared by profile and direction ids. Capped at 30 so the
 * composed Playwright session name ("career-ops-" + p + "-" + d) always fits
 * autopilot-verify's 80-char safeSession() limit: 11 + 30 + 1 + 30 = 72.
 */
export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,29}$/.test(id) && !id.includes('--');
}

/** Turn a display name into a valid id ("Data Analyst" → "data-analyst", «Дизайнер» → "dizayner"). */
export function slugify(text) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const slug = String(text ?? '')
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return isValidId(slug) ? slug : null;
}

export function findProfile(registry, profileId) {
  return (registry?.profiles ?? []).find((p) => p.id === profileId) ?? null;
}

export function findDirection(profile, directionId) {
  return (profile?.directions ?? []).find((d) => d.id === directionId) ?? null;
}

/** The profile's directory (parent of all its direction roots). */
export function profileRoot(profileId, { dataRoot } = {}) {
  if (!isValidId(profileId)) throw new Error(`invalid profile id: ${profileId}`);
  return join(dataRoot ?? getCareerOpsRoot(), 'data', 'profiles', profileId);
}

/**
 * The direction's career-ops data root (absolute). Hand it to CAREER_OPS_ROOT
 * and the whole pipeline relocates into it.
 */
export function directionRoot(profileId, directionId, { dataRoot } = {}) {
  if (!isValidId(profileId)) throw new Error(`invalid profile id: ${profileId}`);
  if (!isValidId(directionId)) throw new Error(`invalid direction id: ${directionId}`);
  return join(dataRoot ?? getCareerOpsRoot(), 'data', 'profiles', profileId, directionId);
}

/**
 * The same root as a code-root-relative posix path, the form the env blocks
 * print: path-resolver resolves relative CAREER_OPS_ROOT values against the
 * CODE root (not cwd), so a relative export works from any shell.
 */
export function directionRootRelative(profileId, directionId, { dataRoot, codeRoot } = {}) {
  const base = codeRoot ?? join(ROOT, '..');
  const absolute = directionRoot(profileId, directionId, { dataRoot });
  return relative(base, absolute).split(sep).join('/');
}

/** Persistent browser profile directory inside a direction root (mirrors the main repo's data/browser-profile). */
export function browserProfileDir(directionRootDir) {
  return join(directionRootDir, 'data', 'browser-profile');
}

/** Autopilot claim owner for a direction — must be unique per parallel worker. */
export function workerIdFor(profileId, directionId) {
  return `${profileId}-${directionId}`;
}

/**
 * Playwright CLI session name for a direction. Must satisfy autopilot-verify's
 * safeSession() (/^[A-Za-z0-9_.-]{1,80}$/) — slugs are capped at 39 chars each
 * so the composed name always fits.
 */
export function sessionNameFor(profileId, directionId) {
  return `career-ops-${profileId}-${directionId}`;
}

/** Atomic registry write: tmp file + rename, retried for Windows rename contention (same idiom as tracker writes). */
export function saveProfiles(registry, { registryFile } = {}) {
  const file = resolveRegistryPath(registryFile);
  const normalized = normalizeRegistry(registry, file);
  const body = yaml.dump(normalized, { lineWidth: 120, noRefs: true });
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, body, 'utf-8');
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, file);
      return file;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
