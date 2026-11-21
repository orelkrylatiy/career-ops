/**
 * Linux-only browser configuration shared by the fork's autonomous tools.
 * Upstream lib/browser-launch.mjs remains unchanged.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';

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
  const child = { ...env, AUTOPILOT_BROWSER_PROFILE: profileDir };
  if (executablePath) {
    child.AUTOPILOT_BROWSER_EXECUTABLE_PATH = executablePath;
    child.PLAYWRIGHT_MCP_EXECUTABLE_PATH = executablePath;
  }
  return child;
}
