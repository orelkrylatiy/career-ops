// Fork-only, deterministic *queue triage* for a wide Frontend/Web funnel.
// A title is a cheap signal, never a substitute for reading the full job description.
// Do not use this module to assert work authorization, actual skills or submissions.
const FOCUS_RE = /(?:front[\s-]?end|фронт[\s-]?енд|full[\s-]?stack|fullstack|react|vue(?:\.?js)?|angular|svelte|next\.?js|nuxt|javascript|typescript|\bui\b|web developer|web engineer|веб[\s-]?разработ)/iu;
const STRONG_RE = /(?:front[\s-]?end|full[\s-]?stack|fullstack|full[\s-]?cycle|(?:react|vue(?:\.?js)?|angular|svelte|next\.?js|nuxt|javascript|typescript|html5|css3|webflow|wordpress|shopify|browser|design[\s-]?systems?|interfaces?|client[\s-]?side|web[\s-]?app(?:lication)?s?)\b|\bui[\s/\-]+(?:engineer|developer|programmer)\b|\b(?:web|website)[\s/\-]+(?:developer|engineer|programmer)\b|\b(?:developer|engineer)[\s/\-]+(?:experience|product[\s-]?ui)\b)/iu;
const FRONTEND_RU_RE = /(?:фронт[\s-]?енд|верстал[ьщ]+ик|веб[\s-]?разработ|разработчик[\s-]+(?:интерфейс|веб[\s-]?прилож)|разработка[\s-]+интерфейс)/iu;
const MOBILE_ONLY_RE = /(?:react[\s-]?native|\b(?:android|ios|swift|kotlin|flutter)[\s/-]+(?:developer|engineer)\b)/iu;
const WEB_EXPLICIT_RE = /(?:front[\s-]?end|фронт[\s-]?енд|full[\s-]?stack|fullstack|\bweb[\s/-]+(?:engineer|developer)\b|\bweb[\s-]?app\b|\bui[\s/-]+engineer\b)/iu;
const POSSIBLE_RE = /(?:\bsoftware[\s-]+(?:engineer|developer|programmer|architect)\b|\bproduct[\s-]+engineer\b|\bapplications?[\s-]+(?:developer|engineer)\b|\b(?:developer|engineer)[\s-]+(?:platform|experience|tools)\b|\bweb[\s-]?3\b)/iu;
const ADJACENT_RE = /(?:\b(?:developer|programmer|software[\s-]?engineer|engineer)\b|разработчик|разработчица|программист|инженер[\s-]программист)/iu;
const UNRELATED_RE = /(?:\b(?:machine learning|mlops|data scientist|data engineer|analytics engineer|qa|quality assurance|sdet|tester|devops|sre|site reliability|backend|back[\s-]?end|database administrator|security engineer|network engineer|embedded|firmware|sales|marketing|retail|warehouse|account manager|customer success|technical support|recruiter|hr|financial analyst|business analyst|product manager|project manager)\b|\b(?:android|ios|swift|kotlin|flutter|react native)[\s-]+(?:developer|engineer)\b|\b(?:go|golang|java|python|rust|c\+\+)[\s-]+(?:backend|engineer|developer)\b|\b(?:ml|ai)[\s-]+engineer\b|\b(?:qa|test)[\s-]+engineer\b|\b(?:мл|бэкенд|бекенд|тестировщик|аналитик|продаж|склад)\b)/iu;

function strings(value) {
  return Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
}

/**
 * Infer a broad frontend focus only from user-owned configuration, never from
 * a global technology list or the user's location. Other directions keep their
 * own upstream title gate unless they explicitly opt into soft title matching.
 * Explicit autopilot.role_family: frontend|general wins.
 */
export function queueRoleFamily(profile = {}, titleFilter = {}) {
  const requested = String(profile?.autopilot?.role_family || '').toLowerCase().trim();
  if (['frontend', 'web', 'fullstack'].includes(requested)) return 'frontend';
  if (requested === 'general') return 'general';
  const terms = [
    ...strings(titleFilter?.positive),
    ...strings(profile?.candidate?.target_roles),
    ...strings(profile?.target_roles),
    profile?.narrative?.headline || '',
    profile?.candidate?.current_title || '',
    profile?.candidate?.headline || '',
  ].join(' ');
  return FOCUS_RE.test(terms) ? 'frontend' : 'general';
}

/**
 * 3 = explicitly web/frontend/UI; 2 = potentially frontend software position;
 * 1 = ambiguous technical development position; 0 = unrelated/nontechnical.
 *
 * Explicit frontend text outranks other stack terms ("Fullstack Java + React").
 * Ambiguous roles reach Codex for FULL-JD validation, where actual skills and
 * mandatory country/work-authorization requirements are checked truthfully.
 */
export function frontendTitleTier(title = '') {
  const name = String(title || '').trim();
  if (!name) return 0;
  // "React Native" by itself is mobile development, not browser frontend.
  // Allow hybrid web+mobile titles only when a web role is explicit.
  if (MOBILE_ONLY_RE.test(name) && !WEB_EXPLICIT_RE.test(name)) return 0;
  if (FRONTEND_RU_RE.test(name) || STRONG_RE.test(name)) return 3;
  if (UNRELATED_RE.test(name)) return 0;
  if (POSSIBLE_RE.test(name)) return 2;
  return ADJACENT_RE.test(name) ? 1 : 0;
}

/**
 * Legacy SQLite priorities may have been calculated under a different profile
 * or an obsolete Russia-first boost. Re-rank IN MEMORY per claim so a stale
 * 100-point sales job never takes precedence over any web/frontend position.
 */
export function queueClaimRank(job, { family = 'general', scoringPriority = 50 } = {}) {
  const priority = Number.isFinite(Number(scoringPriority))
    ? Math.max(0, Math.min(100, Number(scoringPriority))) : 50;
  return family === 'frontend' ? frontendTitleTier(job?.title) * 1000 + priority : priority;
}
