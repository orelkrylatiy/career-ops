#!/usr/bin/env node
// Explicit Gmail flow. Ingest is separate; this command is for outbound mail
// that the user intentionally chooses to send.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadDotenvOnce, loadPluginConfig, pluginStatus, discoverPlugins,
  pluginRoots, resolveSuccessorIds, runHook, filterResultsForId,
} from './plugins/_engine.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log([
    'Usage:',
    '  node gmail-flow.mjs send --to <email> --subject <text> --body <text> [--key <id>] [--dry-run]',
    '  node gmail-flow.mjs send --to <email> --subject <text> --body-file <path> [--key <id>] [--dry-run]',
    '  node gmail-flow.mjs ingest [--dry-run]',
  ].join('\n'));
}

function arg(args, name, required = true) {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} is required`);
  return value;
}

async function ensureGmail() {
  await loadDotenvOnce();
  const cfg = await loadPluginConfig(ROOT);
  const manifest = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT)).find(m => m.id === 'gmail');
  if (!manifest) throw new Error('gmail plugin is not installed');
  const status = pluginStatus(manifest, cfg);
  if (!status.configured) throw new Error('gmail plugin is disabled; enable it in config/plugins.yml first');
  if (status.missingEnv.length) throw new Error(`gmail plugin is missing: ${status.missingEnv.join(', ')}`);
  return cfg;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return usage();
  await ensureGmail();
  const dryRun = args.includes('--dry-run');

  if (command === 'ingest') {
    const results = filterResultsForId(await runHook('ingest', null, { root: ROOT, dryRun, pluginId: 'gmail' }), 'gmail');
    const result = results.find(r => r.ok);
    if (!result) throw new Error(results[0]?.error || 'gmail ingest failed');
    console.log(`gmail ingest: ${Array.isArray(result.result) ? result.result.length : 0} lead(s) found${dryRun ? ' (dry-run)' : ''}.`);
    return;
  }

  if (command !== 'send') throw new Error(`unknown command: ${command}`);
  const to = arg(args, '--to');
  const subject = arg(args, '--subject');
  const bodyFile = arg(args, '--body-file', false);
  const body = bodyFile ? readFileSync(path.resolve(ROOT, bodyFile), 'utf8') : arg(args, '--body');
  const key = arg(args, '--key', false);
  const payload = { to, subject, body, ...(key ? { key } : {}) };
  const results = filterResultsForId(
    await runHook('notify', payload, { root: ROOT, dryRun, pluginId: 'gmail', timeoutMs: 30_000 }),
    'gmail',
  );
  const result = results.find(r => r.ok);
  if (!result) throw new Error(results[0]?.error || 'gmail send failed');
  const sent = result.result;
  console.log(sent.sent
    ? `gmail send: sent ${sent.messageId || '(no id)'} to ${sent.to}.`
    : sent.duplicate
      ? 'gmail send: skipped duplicate key.'
      : 'gmail send: dry-run verified; nothing sent.');
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error(`gmail-flow: ${err.message}`); process.exit(1); });
}
