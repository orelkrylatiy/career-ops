// autopilot-profile.mjs — classify application attempts into user-defined profile/stack buckets.
//
// Profiles live under config/profile.yml:
// autopilot:
//   profiles:
//     frontend:
//       label: Frontend / React
//       stack: [react, next.js, typescript]
//       title_keywords: [frontend, react, next]
//       resume_variants: [react, nextjs]
//       priority: 20
//
// The agent may pass --profile explicitly. Otherwise classification is
// deterministic: selected resume variant is the strongest signal, then title
// keywords, then stack keywords. No profile ever gates an application.

function normalizeList(value) {
  return (Array.isArray(value) ? value : [])
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

export function configuredProfiles(profile) {
  const raw = profile?.autopilot?.profiles;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const rows = [];
  for (const [keyRaw, valueRaw] of Object.entries(raw)) {
    const key = String(keyRaw || '').trim();
    if (!key || !valueRaw || typeof valueRaw !== 'object' || Array.isArray(valueRaw)) continue;
    rows.push({
      key,
      label: typeof valueRaw.label === 'string' && valueRaw.label.trim()
        ? valueRaw.label.trim()
        : key,
      stack: normalizeList(valueRaw.stack),
      title_keywords: normalizeList(valueRaw.title_keywords),
      resume_variants: normalizeList(valueRaw.resume_variants),
      priority: Number.isFinite(Number(valueRaw.priority)) ? Number(valueRaw.priority) : 0,
    });
  }
  return rows;
}

function includesToken(haystack, token) {
  const h = String(haystack || '').toLowerCase();
  const t = String(token || '').toLowerCase().trim();
  return Boolean(t && h.includes(t));
}

export function resolveApplicationProfile({
  job = {},
  profile = {},
  explicitProfile = null,
  resumeVariant = null,
} = {}) {
  const profiles = configuredProfiles(profile);
  if (profiles.length === 0) {
    return explicitProfile
      ? { key: String(explicitProfile), label: String(explicitProfile), stack: [], reason: 'explicit_unconfigured' }
      : null;
  }

  if (explicitProfile) {
    const key = String(explicitProfile).trim().toLowerCase();
    const match = profiles.find((p) => p.key.toLowerCase() === key);
    if (!match) {
      throw new Error(
        `unknown autopilot profile "${explicitProfile}" — configured: ${profiles.map((p) => p.key).join(', ')}`,
      );
    }
    return { ...match, reason: 'explicit' };
  }

  const title = String(job?.title || '');
  const resume = String(resumeVariant || '').trim().toLowerCase();
  let best = null;

  for (const p of profiles) {
    let score = p.priority;
    const reasons = [];

    if (resume && p.resume_variants.some((v) => v.toLowerCase() === resume)) {
      score += 100;
      reasons.push('resume_variant');
    }

    for (const keyword of p.title_keywords) {
      if (includesToken(title, keyword)) {
        score += 20;
        reasons.push(`title:${keyword}`);
      }
    }
    for (const keyword of p.stack) {
      if (includesToken(title, keyword)) {
        score += 8;
        reasons.push(`stack:${keyword}`);
      }
    }

    if (reasons.length === 0) continue;
    if (!best || score > best.score || (score === best.score && p.key.localeCompare(best.profile.key) < 0)) {
      best = { profile: p, score, reasons };
    }
  }

  if (!best) return null;
  return { ...best.profile, reason: best.reasons.join(',') };
}
