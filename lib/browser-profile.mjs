/**
 * Persistent browser directory for one named candidate + direction.
 * Optional CAREER_OPS_BROWSER_STORE_ROOT relocates profiles outside the repo,
 * always into separate <store>/<candidate>/<direction> directories.
 */
import { resolve, join, relative, sep, isAbsolute } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

const valid = id => typeof id === 'string'
  && /^[a-z0-9][a-z0-9-]{0,29}$/.test(id) && !id.includes('--');
function inside(parent, child) {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}

export function browserProfilePath({ directionRoot, person, direction, env = process.env, codeRoot = process.cwd() } = {}) {
  if (!directionRoot) throw new Error('browser profile requires a selected direction');
  const chosen = String(env.CAREER_OPS_BROWSER_STORE_ROOT || '').trim();
  if (!chosen) return resolve(directionRoot, 'data', 'browser-profile');
  if (!valid(person) || !valid(direction)) throw new Error('custom browser storage needs valid candidate/direction ids');
  const root = resolve(codeRoot, chosen);
  const checkout = resolve(codeRoot);
  if (inside(checkout, root)) throw new Error('browser store must be outside the source checkout');
  if (existsSync(root) && existsSync(checkout) && inside(realpathSync(checkout), realpathSync(root))) {
    throw new Error('browser store cannot point inside the source checkout through a symlink');
  }
  return join(root, person, direction);
}
