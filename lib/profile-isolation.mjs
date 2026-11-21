/**
 * Fail-closed identity boundary for an opt-in browser worker.
 *
 * An active CAREER_OPS_ROOT is one candidate/direction, not the shared
 * registry. Two candidates must never reuse a browser session, worker ID,
 * configured resume, tracker, portals, Gmail identity or SQLite database.
 * This module has no third-party dependencies so the rules can be tested
 * without accessing a real candidate's files or launching a browser.
 */
import path from 'node:path';

const SENSITIVE_FILE_OVERRIDES = [
  'CAREER_OPS_PROFILE', 'CAREER_OPS_PORTALS', 'CAREER_OPS_PIPELINE',
  'CAREER_OPS_TRACKER', 'CAREER_OPS_AUTOPILOT_DB',
  'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_EXPANDED_PORTALS',
  'AUTOPILOT_BROWSER_PROFILE', 'CAREER_OPS_GMAIL_DIR',
];

function containsPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
  );
}

export function assertIsolatedAutopilotContext({
  env = process.env,
  dataRoot,
  storeRoot,
  registry = null,
  codeRoot = process.cwd(),
} = {}) {
  if (!dataRoot || !storeRoot) throw new Error('candidate profile roots must be resolved');
  if (!env.CAREER_OPS_ROOT && !env.CAREER_OPS_DATA_DIR) {
    throw new Error('live applications require an explicit CAREER_OPS_ROOT');
  }
  if (!env.AUTOPILOT_BROWSER_SESSION || !env.AUTOPILOT_WORKER_ID) {
    throw new Error('select a direction with profile.mjs env to set an isolated browser session and worker ID');
  }
  const selected = path.resolve(dataRoot);
  const base = path.resolve(storeRoot);
  const known = [];
  for (const person of registry?.profiles || []) {
    for (const direction of person.directions || []) {
      known.push({
        person: person.id,
        direction: direction.id,
        root: path.resolve(base, 'data', 'profiles', person.id, direction.id),
      });
    }
  }
  const active = known.find((item) => item.root === selected);
  if (known.length && !active) {
    throw new Error('CAREER_OPS_ROOT does not match any registered candidate/direction');
  }
  if (!known.length && /[\\/]data[\\/]profiles[\\/]/i.test(selected)) {
    throw new Error('candidate registry unavailable: export all variables printed by profile.mjs env');
  }
  if (active) {
    if (env.AUTOPILOT_WORKER_ID !== active.person + '-' + active.direction) {
      throw new Error('worker ID does not match the selected candidate and direction');
    }
    if (env.AUTOPILOT_BROWSER_SESSION !== 'career-ops-' + active.person + '-' + active.direction) {
      throw new Error('browser session does not match the selected candidate and direction');
    }
  }

  for (const key of SENSITIVE_FILE_OVERRIDES) {
    const configured = env[key]?.trim();
    if (!configured) continue;
    const value = path.resolve(codeRoot, configured);
    if (!containsPath(selected, value)) {
      throw new Error(key + ' must belong to the selected candidate/direction root');
    }
  }
  return active || { person: null, direction: null, root: selected };
}
