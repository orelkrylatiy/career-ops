# Career Ops: upstream-first rebuild

## Provenance

- Original upstream: `career-ops-hq/career-ops` commit `e1c0c1c2cb4e271fb83540dd6cdf3ac943509243` (2026-11-21). The new branch starts directly from this original commit and retains the full original provider, ATS, CV, web and test stack.
- Own extensions from previous fork `main` and draft PR #6: autonomous queue/runner, verification receipts, CAPTCHA text-image detection and OCR, Russian and CIS adapters and source registry, profile isolation, optional Humanizer and Gmail, and focused tests.
- Cleanup: 19 translated *root* README files removed; upstream localized modes and other original files remain. No private candidate data was committed. Legacy `main` and PR #6 are preserved for comparison and rollback.

## Explicitly paused campaign

The campaign of 30 new confirmed frontend applications (at least 10 for Russian-market positions) is paused until the user separately resumes it. No prior application or ambiguous submission counts. HeadHunter and Telegram are excluded. Applications are counted only with strong matching evidence; an uncertain prior Submit must never be blindly repeated.

## Isolated directions

Use `node profile.mjs list` and `node profile.mjs env <person> <direction>` to select one active data root. If needed, add a candidate with `node profile.mjs add-profile <person> --name <name>` and specializations using `node profile.mjs add-direction <person> react|nextjs|vue`. Every direction has independent CV, portals.yml, profile.yml, SQLite DB, tracker and browser profile. Never recreate an existing data root while migrating.

## Safe dry-run and checks

```bash
npm install
node profile.mjs list
npm run autopilot:status
npm run autopilot:preflight
npm run autopilot:dry-run
npm run lint
npm run autopilot:test
node test-all.mjs --quick
npx playwright install chromium
node tests/autopilot-browser-e2e.mjs
```

Do not run these against a live submission scenario. Tests only use fixtures and a local fake-form server.

## Explicit live mode (only after a separate user restart)

Set the chosen direction's `CAREER_OPS_ROOT` and browser session first. For later separately authorized work use `AUTOPILOT_LIVE=1 npm run autopilot:live -- --max-jobs 5`. Normal runs process the existing queue first, do not rescan unnecessarily, and use a bounded per-job timeout; scanning is a separate step or `--scan` opt-in. Full ATS discovery is explicit (`AUTOPILOT_DISCOVERY=full`).

The source list is not an evidence of a working application path. Habr, GeekJob and SuperJob adapters can discover jobs; live browser submissions require independent validation. CAPTCHA support is limited to permitted text-image challenges, not bypassing interactive third-party challenges or MFA.

## Risks and readiness

- The original upstream policy remains in AGENTS.md; only explicitly activated autonomous mode permits Submit without per-job approval.
- The sqlite queue is reconciled against the canonical tracker before claiming a job; no old or duplicate confirmed applications count.
- A worker prompt and safe CLI defaults do NOT constitute a complete filesystem sandbox. For production, run the worker in a restricted OS account/container with only this checkout and the selected data root mounted, no sibling projects.
- Run GitHub Actions tests and the local fake-form E2E; then verify live site compatibility and saved login state separately before switching main or allowing real applications.
- Check historical tracked resume payloads for personally identifiable information before public redistribution. Deleting them from a later branch does not erase their earlier Git history.
