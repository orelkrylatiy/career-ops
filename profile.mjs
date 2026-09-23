#!/usr/bin/env node
import { validateFlags, flagValue } from './lib/cli-flags.mjs';
/**
 * profile.mjs — multi-account manager: profiles → directions.
 *
 * A profile is one person's account (mapped to Telegram user ids for the
 * bot); a direction is a specialization inside it (analyst, designer, react,
 * vue…). Each direction gets its own FULL career-ops data root at
 * data/profiles/<profile>/<direction>/ plus its own browser profile, session
 * and autopilot worker id — this command provisions all of that and prints
 * the exact commands to run a direction in its isolated browser.
 *
 * Run: node profile.mjs list
 *      node profile.mjs add-profile maxim --name Maxim --tg 123456789 --admin
 *      node profile.mjs add-direction maxim analyst --name "Data Analyst"
 *      node profile.mjs env maxim analyst            # exports (bash|powershell)
 *      node profile.mjs launch maxim analyst         # isolated browser command
 *      node profile.mjs stats [maxim [analyst]]      # per-profile/direction stats
 *      node profile.mjs remove-direction maxim analyst [--purge]
 *
 * The registry is profiles.yml (user layer, gitignored; CAREER_OPS_PROFILES
 * overrides the path — tests use it to stay off your real registry).
 */

import {
  existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  loadProfiles, saveProfiles, findProfile, findDirection, isValidId,
  directionRoot, directionRootRelative, profileRoot, browserProfileDir, workerIdFor, sessionNameFor,
} from './lib/profile-registry.mjs';
import { computeDirectionStats, aggregateProfileStats } from './lib/profile-stats.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const VALUE_FLAGS = ['--name', '--tg', '--tg-name', '--shell'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--admin', '--purge', '--run', '--json', '--summary', '--help', '-h'];

const USAGE = `Usage:
  node profile.mjs list [--json]
  node profile.mjs add-profile <id> --name <n> --tg <uid> [--tg-name <n>] [--admin]
  node profile.mjs remove-profile <id> [--purge]
  node profile.mjs add-direction <profile> <id> --name <n>
  node profile.mjs remove-direction <profile> <id> [--purge]
  node profile.mjs env <profile> <direction> [--shell bash|powershell]
  node profile.mjs launch <profile> <direction> [--run]
  node profile.mjs stats [<profile> [<direction>]] [--json|--summary]

Flags:
  --name <n>      display name (profile or direction)
  --tg <uid>      Telegram user id (write to @userinfobot to get yours)
  --tg-name <n>   label for that Telegram user (defaults to --name)
  --admin         this Telegram user also sees every profile in the bot
  --purge         remove-direction/-profile also deletes the data root
  --shell <s>     env output flavor: bash (default) or powershell
  --run           launch also starts the browser, not just prints the command
  --json          machine-readable output on stdout (errors included)`;

/** Positionals = non-flag tokens that are not a value flag's operand (mirrors validateFlags' adjacency rule). */
function positionalArgs(args) {
  const consumed = new Set();
  args.forEach((a, idx) => {
    if (VALUE_FLAGS.includes(a) && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
      consumed.add(idx + 1);
    }
  });
  return args.filter((a, idx) => !consumed.has(idx) && !a.startsWith('-'));
}

function fail(message, { json } = {}) {
  if (json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

function loadOrInit() {
  const registry = loadProfiles();
  if (registry === null) {
    return { registry: { profiles: [] }, fresh: true };
  }
  return { registry, fresh: false };
}

const localDateStr = () => new Date().toISOString().slice(0, 10);

// ── add-direction: the direction skeleton ──────────────────────────

const TRACKER_HEADER = '# Applications Tracker\n\n'
  + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
  + '|---|------|---------|------|-------|--------|-----|--------|-------|\n';

function createDirectionSkeleton(root, directionName) {
  if (existsSync(root)) {
    throw new Error(`direction root already exists: ${root} (remove it first or pick another id)`);
  }
  for (const dir of ['data', 'reports', 'jds', 'output', 'config', 'batch/tracker-additions', 'modes']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'data', 'applications.md'), TRACKER_HEADER, 'utf-8');
  copyFileSync(join(CODE_ROOT, 'config', 'profile.example.yml'), join(root, 'config', 'profile.yml'));
  copyFileSync(join(CODE_ROOT, 'templates', 'portals.example.yml'), join(root, 'portals.yml'));
  copyFileSync(join(CODE_ROOT, 'modes', '_profile.template.md'), join(root, 'modes', '_profile.md'));
  copyFileSync(join(CODE_ROOT, 'modes', '_brief.template.md'), join(root, 'modes', '_brief.md'));
  writeFileSync(
    join(root, 'cv.md'),
    `# CV — ${directionName}\n\n`
    + 'Fill this in with the CV for this direction. Everything generated for\n'
    + 'this direction is grounded exclusively in this file, config/profile.yml\n'
    + 'and modes/_profile.md inside this root.\n',
    'utf-8',
  );
  return [
    'data/applications.md', 'config/profile.yml', 'portals.yml', 'cv.md',
    'modes/_profile.md', 'modes/_brief.md',
  ];
}

// ── env / launch: the isolated worker recipe ───────────────────────

function envLines(profileId, directionId, shell) {
  const rootRel = directionRootRelative(profileId, directionId);
  const vars = [
    ['CAREER_OPS_ROOT', rootRel],
    ['AUTOPILOT_WORKER_ID', workerIdFor(profileId, directionId)],
    ['AUTOPILOT_BROWSER_SESSION', sessionNameFor(profileId, directionId)],
  ];
  if (shell === 'powershell') return vars.map(([k, v]) => `$env:${k}="${v}"`);
  return vars.map(([k, v]) => `export ${k}="${v}"`);
}

function launchCommand(profileId, directionId) {
  const profileRel = [directionRootRelative(profileId, directionId), 'data', 'browser-profile'].join('/');
  return 'npx playwright cli'
    + ` -s=${sessionNameFor(profileId, directionId)}`
    + ' open "about:blank"'
    + ` --profile="${profileRel}"`
    + ' --headed --browser=chrome';
}

// ── stats ──────────────────────────────────────────────────────────

function directionOneLiner(directionId, stats) {
  if (!stats?.tracker) return `${directionId.padEnd(10)} — нет данных`;
  const f = stats.funnel ?? {};
  return `${directionId.padEnd(10)} ${String(stats.tracker.total).padStart(4)} записей · ${f.everApplied ?? 0} откликов · ${f.everInterview ?? 0} интервью · ${f.everOffer ?? 0} офферов`;
}

function cmdStats(registry, args) {
  const json = args.includes('--json');
  const [profileId, directionId] = positionalArgs(args);

  if (directionId) {
    const profile = findProfile(registry, profileId);
    if (!profile) fail(`no profile "${profileId}"`, { json });
    const direction = findDirection(profile, directionId);
    if (!direction) fail(`no direction "${directionId}" in profile "${profileId}"`, { json });
    const stats = computeDirectionStats(directionRoot(profileId, directionId));
    if (json) {
      console.log(JSON.stringify({ profile: profileId, direction: directionId, stats }, null, 2));
    } else if (!stats) {
      console.log(`${profileId}/${directionId}: нет данных (трекер пуст)`);
    } else {
      const t = stats.tracker;
      const f = stats.funnel;
      console.log(`${profileId}/${directionId} — ${direction.name}`);
      console.log(`  Записей: ${t.total} · в работе: ${t.activeApps} · ср. скоринг: ${t.avgScore ?? '—'}`);
      console.log(`  Отклики: ${f.everApplied} · ответы: ${f.everResponded} (${f.responseRate}%) · интервью: ${f.everInterview} (${f.interviewRate}%) · офферы: ${f.everOffer}`);
      if (stats.runs) console.log(`  Сканы: ${stats.runs.totalRuns} прогонов · найдено/прогон: ${stats.runs.avgFoundPerRun}`);
    }
    return;
  }

  const selected = profileId ? [findProfile(registry, profileId) ?? fail(`no profile "${profileId}"`, { json })] : registry.profiles;
  const report = [];
  for (const profile of selected) {
    const entries = profile.directions.map((d) => computeDirectionStats(directionRoot(profile.id, d.id)));
    report.push({
      profile: profile.id,
      name: profile.name,
      directions: profile.directions.map((d, i) => ({
        id: d.id,
        name: d.name,
        applied: entries[i]?.funnel?.everApplied ?? 0,
        total: entries[i]?.tracker?.total ?? 0,
      })),
      aggregate: aggregateProfileStats(entries),
    });
  }
  if (json) {
    console.log(JSON.stringify({ profiles: report }, null, 2));
    return;
  }
  for (const p of report) {
    console.log(`${p.profile} (${p.name})`);
    p.directions.forEach((d, i) => console.log(`  ${directionOneLiner(d.id, { tracker: { total: d.total }, funnel: { everApplied: d.applied } })}`));
    const a = p.aggregate;
    if (a.funnel) {
      console.log(`  Σ направлений: ${a.directions} · откликов: ${a.funnel.everApplied} · интервью: ${a.funnel.everInterview} · офферов: ${a.funnel.everOffer}`);
    } else {
      console.log(`  Σ направлений: ${a.directions} · данных пока нет`);
    }
  }
}

// ── commands ───────────────────────────────────────────────────────

function cmdAddProfile(args) {
  const json = args.includes('--json');
  const [id] = positionalArgs(args);
  if (!id) fail('add-profile requires an id (slug, e.g. maxim)', { json });
  const name = flagValue(args, '--name') ?? id;
  const tg = flagValue(args, '--tg');
  if (!tg) fail('add-profile requires --tg <telegram user id> (write to @userinfobot to get yours)', { json });
  if (!/^\d{1,20}$/.test(tg)) fail(`--tg must be a numeric Telegram user id, got "${tg}"`, { json });
  if (!isValidId(id)) fail(`profile id "${id}" must be a slug: lowercase letters/digits/hyphens, e.g. maxim, react-dev`, { json });

  const { registry } = loadOrInit();
  if (findProfile(registry, id)) fail(`profile "${id}" already exists`, { json });
  registry.profiles.push({
    id,
    name,
    telegram: [{ user_id: tg, name: flagValue(args, '--tg-name') ?? name, admin: args.includes('--admin') }],
    directions: [],
  });
  const file = saveProfiles(registry);
  const out = { profile: id, name, telegram: [{ user_id: tg, admin: args.includes('--admin') }], registry: file };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Profile "${id}" (${name}) saved to ${file}`);
    console.log(`Next: node profile.mjs add-direction ${id} <slug> --name "Specialization"`);
  }
}

function cmdRemoveProfile(args) {
  const json = args.includes('--json');
  const [id] = positionalArgs(args);
  const { registry } = loadOrInit();
  const profile = findProfile(registry, id ?? '');
  if (!profile) fail(`no profile "${id}"`, { json });
  registry.profiles = registry.profiles.filter((p) => p.id !== id);
  saveProfiles(registry);
  let removedRoot = null;
  if (args.includes('--purge')) {
    removedRoot = profileRoot(id);
    if (existsSync(removedRoot)) rmSync(removedRoot, { recursive: true, force: true });
  }
  if (json) console.log(JSON.stringify({ removed: id, purgedRoot: removedRoot }));
  else console.log(`Profile "${id}" removed${removedRoot ? ` (data root ${removedRoot} deleted)` : ' (data root kept; use --purge to delete)'}`);
}

function cmdAddDirection(args) {
  const json = args.includes('--json');
  const [profileId, id] = positionalArgs(args);
  if (!profileId || !id) fail('add-direction requires <profile> <direction-id>', { json });
  if (!isValidId(id)) fail(`direction id "${id}" must be a slug: lowercase letters/digits/hyphens, e.g. analyst, react`, { json });
  const name = flagValue(args, '--name') ?? id;

  const { registry } = loadOrInit();
  const profile = findProfile(registry, profileId);
  if (!profile) fail(`no profile "${profileId}" — add-profile first`, { json });
  if (findDirection(profile, id)) fail(`direction "${id}" already exists in profile "${profileId}"`, { json });

  const root = directionRoot(profileId, id);
  const files = createDirectionSkeleton(root, name);
  profile.directions.push({ id, name, created: localDateStr() });
  saveProfiles(registry);

  if (json) {
    console.log(JSON.stringify({ profile: profileId, direction: id, name, root, files }, null, 2));
    return;
  }
  console.log(`Direction "${profileId}/${id}" (${name}) created at ${root}`);
  console.log(`Skeleton: ${files.join(', ')}`);
  console.log('');
  console.log('Run everything for this direction with its env applied:');
  console.log(envLines(profileId, id, 'bash').map((l) => `  ${l}`).join('\n'));
  console.log('');
  console.log('Open its isolated browser (own cookies/profile):');
  console.log(`  ${launchCommand(profileId, id)}`);
  console.log('');
  console.log('Then finish onboarding inside the direction (CV, profile.yml):');
  console.log('  node doctor.mjs   # with the env above applied');
}

function cmdRemoveDirection(args) {
  const json = args.includes('--json');
  const [profileId, id] = positionalArgs(args);
  const { registry } = loadOrInit();
  const profile = findProfile(registry, profileId ?? '');
  if (!profile) fail(`no profile "${profileId}"`, { json });
  const direction = findDirection(profile, id ?? '');
  if (!direction) fail(`no direction "${id}" in profile "${profileId}"`, { json });
  profile.directions = profile.directions.filter((d) => d.id !== id);
  saveProfiles(registry);
  const root = directionRoot(profileId, id);
  if (args.includes('--purge') && existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (json) console.log(JSON.stringify({ removed: `${profileId}/${id}`, root, purged: args.includes('--purge') }));
  else console.log(`Direction "${profileId}/${id}" removed from registry${args.includes('--purge') ? `, data root ${root} deleted` : ` (data root kept at ${root}; use --purge to delete)`}`);
}

function cmdEnv(args) {
  const json = args.includes('--json');
  const [profileId, directionId] = positionalArgs(args);
  const { registry } = loadOrInit();
  const profile = findProfile(registry, profileId ?? '');
  if (!profile) fail(`no profile "${profileId}"`, { json });
  const direction = findDirection(profile, directionId ?? '');
  if (!direction) fail(`no direction "${directionId}" in profile "${profileId}"`, { json });
  const shell = flagValue(args, '--shell') ?? 'bash';
  if (!['bash', 'powershell'].includes(shell)) fail(`--shell must be bash or powershell, got "${shell}"`, { json });

  if (json) {
    console.log(JSON.stringify({
      profile: profileId, direction: directionId, shell,
      env: Object.fromEntries(envLines(profileId, directionId, 'bash').map((l) => {
        const [, k, v] = l.match(/^export ([A-Z_]+)="(.*)"$/);
        return [k, v];
      })),
    }, null, 2));
    return;
  }
  console.log(`# direction: ${profileId}/${directionId} (${direction.name})`);
  for (const line of envLines(profileId, directionId, shell)) console.log(line);
}

function cmdLaunch(args) {
  const json = args.includes('--json');
  const [profileId, directionId] = positionalArgs(args);
  const { registry } = loadOrInit();
  const profile = findProfile(registry, profileId ?? '');
  if (!profile) fail(`no profile "${profileId}"`, { json });
  if (!findDirection(profile, directionId ?? '')) fail(`no direction "${directionId}" in profile "${profileId}"`, { json });
  const command = launchCommand(profileId, directionId);

  if (json) {
    console.log(JSON.stringify({ profile: profileId, direction: directionId, command, env: envLines(profileId, directionId, 'bash') }, null, 2));
    return;
  }
  console.log('# Apply the direction env first (verifier + autopilot attach by these):');
  for (const line of envLines(profileId, directionId, 'bash')) console.log(line);
  console.log('');
  console.log(command);

  if (args.includes('--run')) {
    const result = spawnSync('npx', ['playwright', 'cli', `-s=${sessionNameFor(profileId, directionId)}`, 'open', 'about:blank',
      `--profile=${join(browserProfileDir(directionRoot(profileId, directionId)))}`, '--headed', '--browser=chrome'],
    { shell: process.platform === 'win32', stdio: 'inherit' });
    process.exit(result.status ?? 0);
  }
}

function cmdList(args) {
  const json = args.includes('--json');
  const { registry, fresh } = loadOrInit();
  if (fresh) {
    if (json) { console.log(JSON.stringify({ profiles: [], hint: 'no profiles.yml yet — node profile.mjs add-profile …' })); return; }
    console.log('No profiles.yml yet. Create the first account:');
    console.log('  node profile.mjs add-profile maxim --name Maxim --tg <your-telegram-id> --admin');
    return;
  }
  cmdStats(registry, [...args]);
}

// ── CLI tail ───────────────────────────────────────────────────────

const COMMANDS = {
  list: cmdList,
  'add-profile': cmdAddProfile,
  'remove-profile': cmdRemoveProfile,
  'add-direction': cmdAddDirection,
  'remove-direction': cmdRemoveDirection,
  env: cmdEnv,
  launch: cmdLaunch,
  stats: cmdStats,
};

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const [command, ...rest] = args;
  if (!command || !COMMANDS[command]) {
    console.error(command ? `Unknown command: ${command}` : 'Missing command.');
    console.error(USAGE);
    process.exit(1);
  }
  if (command === 'stats') {
    // stats reads the registry itself so it also works on a fresh checkout.
    cmdStats(loadOrInit().registry, rest);
  } else {
    COMMANDS[command](rest);
  }
}
