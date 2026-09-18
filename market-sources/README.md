# Market Sources Registry

This fork keeps a versioned discovery registry for the widest practical job funnel across Russia, Kazakhstan, Armenia and Uzbekistan.

## Why this is a registry, not a second database

Career Ops treats human-readable files as canonical. The YAML under this directory is therefore the source registry; runtime health snapshots, discovered ATS endpoints and application state remain derived/user data.

The registry has three layers:

1. **Aggregators / job boards** — `aggregators.yml`. These widen the market beyond any finite employer list.
2. **Employer seeds** — `companies/{ru,kz,am,uz}.yml`. Every entry is fed into ATS discovery even when no hand-curated career URL is known.
3. **Language policy** — `locales.yml`. The actual vacancy/form language wins; country metadata is only fallback.

## Coverage

- **RU** — CNews500 2025 ranks are used for the first 200 IT vendors, plus a separate set of large digital employers whose engineering hiring is material but whose legal/vendor structure does not map cleanly to the CNews vendor table.
- **KZ / AM / UZ** — curated high-signal technology, fintech, telecom, marketplace, banking and engineering employers, plus local job boards. These lists are deliberately seeds, not claims of a formal national top-50 ranking.

A company without `career_url` is **not untracked**. It remains a first-class seed and `market-sources.mjs discover` probes the ATS families already supported by `discover-ats.mjs` (Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Recruitee, BambooHR, Breezy, Pinpoint, Rippling, JOIN and Workday).

## Commands

```bash
npm run sources:stats
npm run sources:verify
npm run sources:export
npm run sources:discover

# Country subsets
node market-sources.mjs stats --countries RU,KZ
node market-sources.mjs verify --countries AM,UZ
node market-sources.mjs discover --countries RU,KZ,AM,UZ
```

`verify` checks every explicit aggregator/career URL and writes the runtime snapshot to `data/market-source-status.json`. Failure does not delete the canonical registry: a temporary 403/429/TLS/network failure is different from a researched source removal.

`discover` exports all company seeds to user data and invokes the existing ATS resolver with `--write`, so resolved employer boards join the normal `portals.yml` / `scan.mjs` path.

## Funnel policy

There is **no local application-count quota** and no fixed maximum number of employers in this registry.

Transport concurrency, retry delays and provider page ceilings are reliability/safety controls only. They prevent a source from being hammered or an untrusted pagination response from creating an infinite request loop; they do not intentionally reduce the set of employers or vacancies considered.

Exact posting URL identity is the hard automatic dedup key. Company+title alone must not collapse jobs because large employers routinely publish multiple requisitions with the same title.

## Language

Do not blindly translate based on country.

1. Detect the language of the vacancy/application form.
2. Use that language for free-text application answers where possible.
3. If detection is inconclusive, use `locales.yml → fallback_order`.
4. Never translate or alter factual identity/CV data merely to fit a locale.

## Research / refresh discipline

`verified_on` records when the registry was researched. Direct URLs marked `career_status: live` were found as active career surfaces at that time. Entries without a direct URL still participate in ATS discovery.

For a refresh:

1. run `npm run sources:verify`;
2. review failures (redirects, 403, moved career pages);
3. run `npm run sources:discover`;
4. update the YAML only when the source itself changed, not because of one transient request failure.

### Primary source families used for the 2026-09-18 refresh

- CNews500 2025 IT-company ranking for the RU top-200 seed.
- Employer-owned career pages where available.
- Kazakhstan: Enbek and employer-owned career pages.
- Armenia: Staff.am, CareerCenter.am, JobFinder.am, MyJob.am, List.am and employer-owned pages.
- Uzbekistan: IT Park resident ecosystem, Ishkop, UzJobs, hh.uz/other boards and employer-owned pages.

HeadHunter is retained as an important market lane, but its API access requirements changed in 2026. The registry therefore treats it as an external board/browser-or-registered-API source rather than assuming anonymous `GET /vacancies` will always work.
