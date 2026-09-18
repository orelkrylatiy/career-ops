#!/usr/bin/env node
/**
 * market-sources.mjs — country-aware discovery registry for the autonomous funnel.
 *
 * Registry is versioned YAML under market-sources/. Runtime health is derived,
 * never canonical.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const REGISTRY_ROOT = path.join(CODE_ROOT, 'market-sources');
const COMPANY_ROOT = path.join(REGISTRY_ROOT, 'companies');
const AGGREGATORS_FILE = path.join(REGISTRY_ROOT, 'aggregators.yml');
const LOCALES_FILE = path.join(REGISTRY_ROOT, 'locales.yml');
const COUNTRY_FILES = { RU: 'ru.yml', KZ: 'kz.yml', AM: 'am.yml', UZ: 'uz.yml' };
const DEFAULT_COUNTRIES = Object.keys(COUNTRY_FILES);

function parseCountries(argv) {
  const eq = argv.find(a => a.startsWith('--countries='));
  const i = argv.indexOf('--countries');
  const raw = eq ? eq.slice('--countries='.length) : (i >= 0 ? argv[i + 1] : '');
  const values = raw ? raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_COUNTRIES;
  const bad = values.filter(c => !COUNTRY_FILES[c]);
  if (bad.length) throw new Error('unknown countries: ' + bad.join(', ') + ' (supported: ' + DEFAULT_COUNTRIES.join(', ') + ')');
  return [...new Set(values)];
}

function flagValue(argv, name, fallback = null) {
  const eq = argv.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

function loadYaml(file) {
  const value = yaml.load(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('invalid YAML object: ' + file);
  return value;
}

export function loadMarketRegistry(countries = DEFAULT_COUNTRIES) {
  const markets = countries.map(country => {
    const file = path.join(COMPANY_ROOT, COUNTRY_FILES[country]);
    const doc = loadYaml(file);
    const ranked = Array.isArray(doc.companies) ? doc.companies : [];
    const extra = Array.isArray(doc.additional_employers) ? doc.additional_employers : [];
    return { ...doc, country, companies: [...ranked, ...extra], ranked_count: ranked.length, extra_count: extra.length };
  });
  const aggregators = loadYaml(AGGREGATORS_FILE).sources ?? [];
  const localeDoc = loadYaml(LOCALES_FILE);
  const locales = Object.fromEntries(
    Object.entries(localeDoc.markets ?? {}).filter(([country]) => countries.includes(country)),
  );
  return {
    markets,
    locales,
    locale_policy: localeDoc.policy ?? {},
    aggregators: aggregators.filter(s => countries.includes(String(s.country || '').toUpperCase())),
  };
}

export function registryStats(registry) {
  const perCountry = {};
  let companies = 0;
  let explicitCareerUrls = 0;
  for (const market of registry.markets) {
    const unique = new Set();
    for (const c of market.companies) {
      const key = String(c.name || '').trim().toLowerCase();
      if (key) unique.add(key);
      if (c.career_url) explicitCareerUrls += 1;
    }
    perCountry[market.country] = {
      ranked: market.ranked_count,
      additional: market.extra_count,
      unique_companies: unique.size,
      aggregators: registry.aggregators.filter(s => s.country === market.country).length,
      languages: market.languages ?? [],
    };
    companies += unique.size;
  }
  return { companies, explicitCareerUrls, aggregators: registry.aggregators.length, perCountry };
}

export function exportCompanySeeds(registry) {
  const seen = new Set();
  const companies = [];
  for (const market of registry.markets) {
    for (const c of market.companies) {
      const name = String(c.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const locale = registry.locales?.[market.country] ?? {};
      const row = {
        name,
        market: market.country,
        languages: market.languages ?? [],
        application_languages: locale.fallback_order ?? market.languages ?? [],
      };
      if (c.career_url) row.website = c.career_url;
      companies.push(row);
    }
  }
  return { companies };
}

async function probeUrl(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'career-ops-market-verifier/1.0' },
      signal: controller.signal,
    });
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 400,
      redirect: res.headers.get('location') || null,
    };
  } catch (err) {
    return { status: null, ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyRegistry(registry) {
  const targets = [];
  for (const source of registry.aggregators) {
    if (source.url) targets.push({ kind: 'aggregator', id: source.id, country: source.country, url: source.url });
  }
  for (const market of registry.markets) {
    for (const company of market.companies) {
      if (company.career_url) targets.push({ kind: 'career', id: company.name, country: market.country, url: company.career_url });
    }
  }
  const results = [];
  const workers = Math.min(12, Math.max(1, targets.length));
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const i = next++;
      if (i >= targets.length) return;
      const target = targets[i];
      results[i] = { ...target, ...(await probeUrl(target.url)) };
    }
  }));
  return results;
}

function writeExport(registry, outFile) {
  const payload = exportCompanySeeds(registry);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, yaml.dump(payload, { lineWidth: 120, noRefs: true }), 'utf8');
  return payload.companies.length;
}

function usage() {
  console.log([
    'Usage:',
    '  node market-sources.mjs stats [--countries RU,KZ,AM,UZ]',
    '  node market-sources.mjs export [--countries ...] [--out data/market-companies.yml]',
    '  node market-sources.mjs verify [--countries ...] [--json]',
    '  node market-sources.mjs discover [--countries ...]',
  ].join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'stats';
  if (argv.includes('--help') || argv.includes('-h')) { usage(); return; }
  const countries = parseCountries(argv);
  const registry = loadMarketRegistry(countries);

  if (cmd === 'stats') {
    console.log(JSON.stringify(registryStats(registry), null, 2));
    return;
  }

  if (cmd === 'export' || cmd === 'discover') {
    const out = path.resolve(DATA_ROOT, flagValue(argv, '--out', 'data/market-companies.yml'));
    const count = writeExport(registry, out);
    console.error('market-sources: exported ' + count + ' unique company seeds -> ' + out);
    if (cmd === 'export') return;

    const args = [path.join(CODE_ROOT, 'discover-ats.mjs'), '--in', out, '--write'];
    const run = spawnSync(process.execPath, args, { cwd: CODE_ROOT, stdio: 'inherit', shell: false });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error('discover-ats.mjs exited ' + run.status);
    return;
  }

  if (cmd === 'verify') {
    const results = await verifyRegistry(registry);
    const summary = {
      checked: results.length,
      live: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    };
    const statusDir = path.join(DATA_ROOT, 'data');
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(path.join(statusDir, 'market-source-status.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      countries,
      ...summary,
    }, null, 2) + '\n', 'utf8');
    if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log('checked=' + summary.checked + ' live=' + summary.live + ' failed=' + summary.failed);
      for (const r of results.filter(r => !r.ok)) console.log('FAIL ' + r.country + ' ' + r.kind + ' ' + r.id + ': ' + (r.status ?? r.error));
    }
    process.exitCode = summary.failed ? 1 : 0;
    return;
  }

  usage();
  process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('market-sources: ' + (err?.message ?? err));
    process.exit(1);
  });
}
