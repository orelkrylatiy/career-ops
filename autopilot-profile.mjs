#!/usr/bin/env node
// autopilot-profile.mjs — deterministic application-profile classification.
//
// Profiles are user-owned analytics buckets, not eligibility gates. They let
// the autonomous worker answer questions such as "how many frontend vs mobile
// applications did I send?" without changing which jobs enter the queue.
//
// Configure them under profile.yml:
//
// autopilot:
//   profiles:
//     frontend:
//       label: Frontend / React
//       stack: [react, typescript, next.js]
//       title_keywords: [frontend, react, next.js]
//       resume_variants: [react, nextjs]
//     mobile:
//       label: React Native
//       stack: [react native, expo, ios, android]
//       title_keywords: [react native, mobile]
//       resume_variants: [react-native]

function strings(value) {
  return (Array.isArray(value) ? value : [])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

function includesToken(text, token) {
  return String(text || '').toLowerCase().includes(String(token || '').toLowerCase());
}

export function normalizeApplicationProfiles(profile = {}) {
  const raw = profile?.autopilot?.profiles;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const out = [];
  for (const [idRaw, cfgRaw] of Object.entries(raw)) {
    const id = String(idRaw || '').trim();
    if (!id) continue;
    const cfg = cfgRaw && typeof cfgRaw === 'object' && !Array.isArray(cfgRaw) ? cfgRaw : {};
    out.push({
      id,
      label: typeof cfg.label === 'string' && cfg.label.trim() ? cfg.label.trim() : id,
      stack: strings(cfg.stack),
      titleKeywords: strings(cfg.title_keywords),
      resumeVariants: strings(cfg.resume_variants),
      priority: Number.isFinite(Number(cfg.priority)) ? Number(cfg.priority) : 0,
    });
  }
  return out;
}

export function resolveApplicationProfile({
  profile = {},
  requested = null,
  resumeVariant = null,
  title = '',
} = {}) {
  const defs = normalizeApplicationProfiles(profile);
  if (requested != null && String(requested).trim()) {
    const needle = String(requested).trim().toLowerCase();
    const exact = defs.find((d) => d.id.toLowerCase() === needle);
    if (exact) return { ...exact, matchedBy: 'explicit' };

    // Reporting happens after a potentially real Submit. Analytics metadata
    // must never make that durable result fail just because an agent/user typed
    // a profile id that is not in profile.yml. Keep it as an ad-hoc bucket;
    // configuring it later adds the label/stack metadata without rewriting
    // historical application rows.
    const id = String(requested).trim().slice(0, 120);
    return {
      id,
      label: id,
      stack: [],
      titleKeywords: [],
      resumeVariants: [],
      priority: 0,
      matchedBy: 'explicit-ad-hoc',
    };
  }

  if (defs.length === 0) {
    return {
      id: 'unclassified',
      label: 'Unclassified',
      stack: [],
      titleKeywords: [],
      resumeVariants: [],
      priority: 0,
      matchedBy: 'fallback',
    };
  }

  const resume = String(resumeVariant || '').trim().toLowerCase();
  const candidates = defs.map((def, index) => {
    const resumeHit = Boolean(resume && def.resumeVariants.some((v) => v.toLowerCase() === resume));
    const titleHits = def.titleKeywords.filter((k) => includesToken(title, k));
    const stackHits = def.stack.filter((k) => includesToken(title, k));
    // Resume routing is the strongest automatic signal because the application
    // actually used that CV. Title keywords are next; stack words are a weak
    // tie-breaker because many stacks never appear in the title.
    const signalScore = (resumeHit ? 1000 : 0)
      + (titleHits.length * 100)
      + (stackHits.length * 10);
    const score = signalScore > 0 ? signalScore + def.priority : 0;
    return { def, score, resumeHit, titleHits, stackHits, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    return {
      id: 'unclassified',
      label: 'Unclassified',
      stack: [],
      titleKeywords: [],
      resumeVariants: [],
      priority: 0,
      matchedBy: 'fallback',
    };
  }
  return {
    ...best.def,
    matchedBy: best.resumeHit ? 'resume' : (best.titleHits.length ? 'title' : 'stack'),
  };
}

export function configuredProfileSummary(profile = {}) {
  return normalizeApplicationProfiles(profile).map((p) => ({
    id: p.id,
    label: p.label,
    stack: p.stack,
    title_keywords: p.titleKeywords,
    resume_variants: p.resumeVariants,
  }));
}
