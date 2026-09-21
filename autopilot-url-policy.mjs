// autopilot-url-policy.mjs — structural destination guard for autonomous web applications.
//
// This is defense in depth, not a complete browser sandbox. It deterministically
// refuses obvious local/private/metadata destinations before a claimed job is
// handed to Playwright CLI.

import { isIP } from 'node:net';

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.websites',
]);

function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function privateIpv4(host) {
  const p = parseIpv4(host);
  if (!p) return false;
  const [a, b] = p;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
  );
}

function normalizeHost(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function privateIpv6(host) {
  const h = normalizeHost(host);
  if (!h || isIP(h) !== 6) return false;
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? privateIpv4(mapped[1]) : false;
}

export function inspectApplicationUrl(raw, {
  allowPrivate = process.env.AUTOPILOT_ALLOW_PRIVATE_URLS === '1',
} = {}) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return { ok: false, reason: 'invalid_url', url: null };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, reason: 'non_http_url', url: null };
  }

  const host = normalizeHost(url.hostname);
  if (!host) return { ok: false, reason: 'missing_host', url: null };
  if (allowPrivate) return { ok: true, reason: null, url: url.href };

  if (
    PRIVATE_HOSTNAMES.has(host)
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) {
    return { ok: false, reason: 'private_hostname', url: null };
  }

  const version = isIP(host);
  if ((version === 4 && privateIpv4(host)) || (version === 6 && privateIpv6(host))) {
    return { ok: false, reason: 'private_ip', url: null };
  }

  return { ok: true, reason: null, url: url.href };
}

export function assertPublicApplicationUrl(raw, options) {
  const result = inspectApplicationUrl(raw, options);
  if (!result.ok) {
    throw new Error(
      `refusing non-public application URL (${result.reason}): ${String(raw || '')}`,
    );
  }
  return result.url;
}
