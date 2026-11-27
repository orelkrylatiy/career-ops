/**
 * Linux-only browser configuration shared by the fork's autonomous tools.
 * Upstream lib/browser-launch.mjs remains unchanged.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { chromiumSandboxStatus } from './browser-launch.mjs';

export function assertLinux(platform = process.platform) {
  if (platform !== 'linux') throw new Error('Career Ops autonomous browser sessions support Linux only');
}

function checkBinary(file) {
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    accessSync(file, constants.X_OK);
  } catch {
    throw new Error('Configured browser executable is missing or not executable: ' + file);
  }
}

export function linuxBrowserSettings({
  env = process.env,
  dataRoot = getCareerOpsRoot(),
  platform = process.platform,
  checkExecutable = checkBinary,
} = {}) {
  assertLinux(platform);
  const executablePath = String(env.AUTOPILOT_BROWSER_EXECUTABLE_PATH
    || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || env.PLAYWRIGHT_MCP_EXECUTABLE_PATH || '').trim();
  if (executablePath) {
    if (!isAbsolute(executablePath)) throw new Error('Browser executable must be an absolute Linux path: ' + executablePath);
    checkExecutable(executablePath);
  }
  const chosen = String(env.AUTOPILOT_BROWSER_PROFILE || '').trim();
  const profileDir = chosen ? resolve(dataRoot, chosen) : join(dataRoot, 'data', 'browser-profile');
  return { executablePath: executablePath || null, profileDir };
}

export function browserCliEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const { executablePath, profileDir } = linuxBrowserSettings({ ...options, env });
  // Browser tools (including wrappers such as Clearcote) may write into
  // ~/.cache, outside Codex's one explicitly writable candidate directory.
  // Keep all browser/cache state scoped to the selected candidate direction.
  // An explicit AUTOPILOT_CACHE_DIR may override the location, but never
  // inherit an unrelated global XDG_CACHE_HOME for a sandboxed worker.
  const chosenCache = String(env.AUTOPILOT_CACHE_DIR || '').trim();
  const cacheDir = chosenCache ? resolve(options.dataRoot ?? getCareerOpsRoot(), chosenCache)
    : join(options.dataRoot ?? getCareerOpsRoot(), 'data', 'autopilot', 'browser-cache');
  const child = { ...env, AUTOPILOT_BROWSER_PROFILE: profileDir, XDG_CACHE_HOME: cacheDir };
  // Reuse upstream's explicit opt-out (including the selected data-root .env).
  // Do not silently disable CLI sandboxing based on a host capability probe:
  // the real agent can run under a different sandbox. An explicit CLI override wins.
  if (!Object.hasOwn(env, 'PLAYWRIGHT_MCP_SANDBOX')
      && chromiumSandboxStatus({
        projectRoot: options.dataRoot ?? getCareerOpsRoot(),
        processEnv: env, executablePath,
      }).reason === 'disabled') {
    child.PLAYWRIGHT_MCP_SANDBOX = '0';
  }
  if (executablePath) {
    child.AUTOPILOT_BROWSER_EXECUTABLE_PATH = executablePath;
    child.PLAYWRIGHT_MCP_EXECUTABLE_PATH = executablePath;
  }
  return child;
}
