/**
 * lib/humanizer.mjs — Node side of the humanizer-framework bridge.
 *
 * The communication framework (voice + AI-ism validation + fallback-chain
 * generation) is Python; this repo is Node. Every helper here spawns
 * `humanizer-bridge.py` (repo root) and reads exactly one JSON object from
 * stdout.
 *
 * Soft-fail contract: when Python, the bridge script or the framework is
 * unavailable, helpers resolve to `null` instead of throwing, so callers
 * (modes, pipelines) degrade to their pre-bridge behavior. `null` means
 * "infrastructure missing"; an object with `ok: false` means the bridge ran
 * but rejected the request.
 *
 * The bridge is a consumer of facts, never a source: pass candidate facts
 * via `context` (from cv.md / profile / report), never let generated text
 * introduce claims the in-scope files do not back (AGENTS.md → Source-of-
 * Truth Boundary).
 *
 * Env:
 *   HUMANIZER_PY         comma list of python launchers (default "py,python3,python")
 *   HUMANIZER_BRIDGE     override bridge script path
 *   HUMANIZER_TIMEOUT_MS per-call timeout (default 180000 — a generation can
 *                        legitimately walk the whole provider fallback chain)
 *   HUMANIZER_NO_CACHE   1 = re-probe availability on every call
 *   HUMANIZER_QUIET      1 = silence the console.warn diagnostics (tests)
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const QUIET = process.env.HUMANIZER_QUIET === '1';

const BRIDGE_PATH =
  process.env.HUMANIZER_BRIDGE ||
  fileURLToPath(new URL('../humanizer-bridge.py', import.meta.url));
const PY_LAUNCHERS = (process.env.HUMANIZER_PY || 'py,python3,python')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const TIMEOUT_MS = Number(process.env.HUMANIZER_TIMEOUT_MS || 180000);

let cachedAvailable;

/**
 * Spawn the bridge once and parse its single JSON reply.
 * Rejects with {code:'ENOENT'} when the launcher does not exist (caller
 * tries the next launcher), other rejections are real failures.
 */
function runOnce(launcher, args, { input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, ['-X', 'utf8', BRIDGE_PATH, ...args], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `bridge printed non-JSON output${stderr ? `: ${stderr.slice(0, 200)}` : ''}`
          )
        );
      }
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

async function runBridge(args, { input, timeoutMs = TIMEOUT_MS } = {}) {
  let lastLauncherError;
  for (const launcher of PY_LAUNCHERS) {
    try {
      return await runOnce(launcher, args, { input, timeoutMs });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        lastLauncherError = err;
        continue; // no such python on this machine — try the next launcher
      }
      if (!QUIET) {
        console.warn(`[humanizer] bridge call failed: ${err?.message || err}`);
      }
      return null;
    }
  }
  if (!QUIET) {
    console.warn(
      `[humanizer] no python launcher found (tried: ${PY_LAUNCHERS.join(', ')}) — bridge disabled`
    );
  }
  return null;
}

/**
 * Probe the bridge once per process: framework importable, chain legs and
 * key availability. Cached; HUMANIZER_NO_CACHE=1 (or {refresh:true}) re-probes.
 */
export async function humanizerAvailable({ refresh = false } = {}) {
  if (
    !refresh &&
    cachedAvailable !== undefined &&
    process.env.HUMANIZER_NO_CACHE !== '1'
  ) {
    return cachedAvailable;
  }
  const report = await runBridge(['selfcheck'], { timeoutMs: 30000 });
  cachedAvailable = Boolean(report?.ok);
  return cachedAvailable;
}

/**
 * Generate a validated outgoing text.
 * @param {object} opts
 * @param {string} opts.goal      what this message should achieve (plain language)
 * @param {string} [opts.channel] framework channel policy (default "hh")
 * @param {string} [opts.type]    outreach | application | chat_reply | follow_up | scheduling | objection
 * @param {string} [opts.language] output language (default "en")
 * @param {string} [opts.profile] framework profile label (default "career-ops")
 * @param {object} [opts.context] candidate facts (from in-scope files only)
 * @param {Array}  [opts.dialogue] prior turns as ["user"|"assistant", text] pairs
 * @param {string[]} [opts.rules] extra business rules
 * @param {string} [opts.voiceMd] persona file (default voice-dna.md)
 * @returns {Promise<{ok:true,text,provider,rewritten,issues}|{ok:false,error}|null>}
 */
export async function humanizerWrite(opts) {
  if (!opts?.goal) return null;
  const args = [
    'write',
    '--goal',
    String(opts.goal),
    '--channel',
    String(opts.channel || 'hh'),
    '--type',
    String(opts.type || 'application'),
    '--language',
    String(opts.language || 'en'),
    '--profile',
    String(opts.profile || 'career-ops'),
  ];
  if (opts.context) args.push('--context', JSON.stringify(opts.context));
  if (opts.dialogue) args.push('--dialogue', JSON.stringify(opts.dialogue));
  for (const rule of opts.rules || []) args.push('--rule', String(rule));
  if (opts.voiceMd) args.push('--voice-md', String(opts.voiceMd));
  return runBridge(args);
}

/**
 * Offline validate/normalize a draft (no LLM call).
 * @param {string} text draft to check (piped to the bridge via stdin)
 * @param {object} [opts] channel/type/language/dialogue/voiceMd overrides
 * @returns {Promise<{ok:true,text,hard,issues}|{ok:false,error}|null>}
 */
export async function humanizerValidate(text, opts = {}) {
  if (!text || !String(text).trim()) return null;
  const args = [
    'validate',
    '--channel',
    String(opts.channel || 'hh'),
    '--type',
    String(opts.type || 'application'),
    '--language',
    String(opts.language || 'en'),
    '--profile',
    String(opts.profile || 'career-ops'),
  ];
  if (opts.dialogue) args.push('--dialogue', JSON.stringify(opts.dialogue));
  if (opts.voiceMd) args.push('--voice-md', String(opts.voiceMd));
  return runBridge(args, { input: String(text), timeoutMs: opts.timeoutMs ?? 60000 });
}
