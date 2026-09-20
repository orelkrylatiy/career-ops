#!/usr/bin/env node
// Deterministic resume resolver for the autonomous worker.
//
// It does not generate CV content. The agent may first use Career-Ops' normal
// tailoring/PDF pipeline and pass the resulting PDF as --generated. If that
// generated artifact is missing or generation failed, this resolver selects a
// prepared resume variant and finally the legacy autopilot.cv_pdf fallback.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { auditLog } from './autopilot-log.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || path.join(DATA_ROOT, 'config', 'profile.yml');

function loadProfile(profilePath = PROFILE_PATH) {
  if (!existsSync(profilePath)) return {};
  const parsed = yaml.load(readFileSync(profilePath, 'utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function normalizeList(value) {
  return (Array.isArray(value) ? value : [])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().toLowerCase());
}

function safeResumePath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const rel = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(rel) || rel.split('/').includes('..')) return null;
  if (!/^(?:output|data)\//.test(rel)) return null;
  return rel;
}

function existingResume(raw) {
  const rel = safeResumePath(raw);
  if (!rel) return null;
  const abs = path.resolve(DATA_ROOT, rel);
  return existsSync(abs) ? { rel, abs } : null;
}

export function scoreResumeVariant(variant, title = '', description = '') {
  const titleText = String(title).toLowerCase();
  const bodyText = String(description).toLowerCase();
  const titleKeywords = normalizeList(variant?.title_keywords);
  const bodyKeywords = normalizeList(variant?.keywords);
  const titleHits = titleKeywords.filter((k) => titleText.includes(k));
  const bodyHits = bodyKeywords.filter((k) => bodyText.includes(k));
  const priority = Number.isFinite(Number(variant?.priority)) ? Number(variant.priority) : 0;
  return {
    score: titleHits.length * 10 + bodyHits.length * 2 + priority / 1000,
    titleHits,
    bodyHits,
    priority,
  };
}

export function resolveResume({
  profile = loadProfile(),
  title = '',
  description = '',
  explicitVariant = null,
  generatedPath = null,
} = {}) {
  const ap = profile?.autopilot && typeof profile.autopilot === 'object' ? profile.autopilot : {};
  const resumes = ap?.resumes && typeof ap.resumes === 'object' ? ap.resumes : {};
  const variants = resumes?.variants && typeof resumes.variants === 'object' ? resumes.variants : {};
  const preferGenerated = resumes.prefer_generated !== false;

  if (explicitVariant) {
    const variant = variants[explicitVariant];
    if (!variant) return { ok: false, reason: 'unknown_variant', requested: explicitVariant };
    const file = existingResume(variant.file);
    if (!file) return { ok: false, reason: 'variant_file_missing', variant: explicitVariant, path: safeResumePath(variant.file) };
    return { ok: true, variant: explicitVariant, path: file.rel, source: 'explicit' };
  }

  if (generatedPath && preferGenerated) {
    const generated = existingResume(generatedPath);
    if (generated) return { ok: true, variant: 'tailored', path: generated.rel, source: 'generated' };
  }

  const ranked = Object.entries(variants)
    .map(([name, variant]) => ({ name, variant, ...scoreResumeVariant(variant, title, description) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.priority - a.priority || a.name.localeCompare(b.name));

  for (const row of ranked) {
    const file = existingResume(row.variant.file);
    if (file) {
      return {
        ok: true,
        variant: row.name,
        path: file.rel,
        source: generatedPath ? 'generated_fallback_match' : 'match',
        matched: [...row.titleHits, ...row.bodyHits],
      };
    }
  }

  const fallbackName = typeof resumes.fallback === 'string' ? resumes.fallback.trim() : '';
  if (fallbackName && variants[fallbackName]) {
    const file = existingResume(variants[fallbackName].file);
    if (file) {
      return {
        ok: true,
        variant: fallbackName,
        path: file.rel,
        source: generatedPath ? 'generated_fallback_default' : 'fallback',
      };
    }
  }

  const legacy = existingResume(ap.cv_pdf);
  if (legacy) {
    return {
      ok: true,
      variant: 'legacy-default',
      path: legacy.rel,
      source: generatedPath ? 'generated_fallback_legacy' : 'legacy',
    };
  }

  return {
    ok: false,
    reason: generatedPath ? 'generated_missing_and_no_fallback' : 'no_resume_available',
    generated: safeResumePath(generatedPath),
  };
}

export function validateResumeConfig(profile = loadProfile()) {
  const ap = profile?.autopilot ?? {};
  const variants = ap?.resumes?.variants ?? {};
  const problems = [];
  for (const [name, variant] of Object.entries(variants)) {
    const rel = safeResumePath(variant?.file);
    if (!rel) problems.push(name + ': file must be a repo/data-root relative path under output/ or data/');
    else if (!existsSync(path.resolve(DATA_ROOT, rel))) problems.push(name + ': missing ' + rel);
  }
  if (ap?.resumes?.fallback && !variants[ap.resumes.fallback]) {
    problems.push('fallback: unknown variant ' + ap.resumes.fallback);
  }
  if (Object.keys(variants).length === 0 && !existingResume(ap.cv_pdf)) {
    problems.push('no prepared resume variants and autopilot.cv_pdf is missing');
  }
  return problems;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const eq = argv.find((v) => v.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function readDescription(argv) {
  const direct = argValue(argv, '--description');
  const file = argValue(argv, '--jd-file');
  if (direct != null) return direct;
  if (!file) return '';
  const full = path.isAbsolute(file) ? file : path.resolve(DATA_ROOT, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

function cli() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'select';
  if (command === 'validate') {
    const problems = validateResumeConfig();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('resume config OK');
    }
    return;
  }
  if (command !== 'select') {
    console.error('usage: node autopilot-resume.mjs select [--title "..."] [--description "..."] [--jd-file path] [--variant name] [--generated path] [--json]');
    console.error('       node autopilot-resume.mjs validate');
    process.exitCode = 2;
    return;
  }
  const result = resolveResume({
    title: argValue(argv, '--title') || '',
    description: readDescription(argv),
    explicitVariant: argValue(argv, '--variant') || null,
    generatedPath: argValue(argv, '--generated') || null,
  });
  auditLog('resume_selected', {
    ok: result.ok,
    variant: result.variant ?? null,
    resume_path: result.path ?? null,
    source: result.source ?? null,
    reason: result.reason ?? null,
  }, { level: result.ok ? 'info' : 'warn' });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(result.path);
  else console.error('resume selection failed: ' + result.reason);
  if (!result.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) cli();
