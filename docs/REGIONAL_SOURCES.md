# Russian and regional job sources (Career Ops fork)

[Autopilot guide](./AUTOPILOT.md) · [CAPTCHA](./CAPTCHA.md) · [architecture](./AUTOPILOT_ARCHITECTURE.md)

These modules are **discovery adapters**. Their presence in the repository does **not** prove live API availability or the ability to submit an application. The original international Career Ops provider/ATS collection remains available unchanged.

## Supported source inventory

| Source | Discovery implementation | Application route | Verification still required |
| --- | --- | --- | --- |
| Habr Career | `providers/habr-career.mjs`; JSON state of search pages, pagination and ID dedup | Authorized browser account | Current sign-in state, form DOM, verification and site challenge |
| GeekJob | `providers/geekjob.mjs`; public JSON search, pagination | Browser form | Current API behavior, registration and confirmation |
| SuperJob | `providers/superjob.mjs`; HTML / JSON-LD search | Browser form | Search availability and current markup/fields |
| getmatch | `catalog/source-catalog.yml` entry | Not implemented as a dedicated adapter | Discover a supported source, do not claim support |
| Russian employers using Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Workday, etc. | Original Career Ops ATS discovery | Browser/ATS form | Validate actual fit and form availability |
| Huntflow, Potok, Skillaz, Talantix | No dedicated fork adapter | No guaranteed automated route | Build and test separately if needed |
| HeadHunter (.ru/.kz/.uz) | **Excluded in autonomous mode** | **Never use** | Separate from this project |
| Telegram | **Excluded in autonomous mode** | **Never use** | No Telegram contacts or cross-project research |

Additional CIS adapters may be present: `careercenter-am`, `ishuz`, and `staffam`. Availability and local eligibility require separate verification. Provider-file count is not a tested-site count.

## Configuration and selection

- The selected direction's `portals.yml` holds configured employers and boards. `provider:` or recognized `careers_url`/`api` fields map the entry to an adapter.
- `catalog/source-catalog.yml` contains country-scoped entries such as `ru-habr-career`, `ru-geekjob` and `ru-superjob`, mapped to provider IDs `habr-career`, `geekjob`, `superjob`.
- `source-registry.mjs export --country RU` merges candidate settings and catalog entries into `data/portals-regional.generated.yml` under the active `CAREER_OPS_ROOT`. It must **not** overwrite the candidate's `portals.yml`.
- The scanner adapter `autopilot-scan.mjs` passes a temporary YAML configuration to the upstream scanner. It removes soft preferences only for discovery. Explicit market rules, blacklists, eligibility and application evidence remain binding for actual sends.
- A full ATS discovery is optional and potentially expensive. Never begin wide discovery before checking the existing queue.

## Commands (safe, no submissions)

```bash
# Select the intended React/Next.js/Vue direction FIRST.
node profile.mjs list
node source-registry.mjs status --json
node source-registry.mjs export --country RU
CAREER_OPS_PORTALS="$CAREER_OPS_ROOT/data/portals-regional.generated.yml" npm run autopilot:wide-scan
npm run autopilot:dry-run
npm run autopilot:status
```

`node source-registry.mjs full --country RU` performs additional network discovery and is not a substitute for testing each live provider. `AUTOPILOT_DISCOVERY=full` opts into the expensive upstream ATS sweep when `--scan` is requested.

## Known operational risks

- Source counts distinguish **configured**, **provider matched**, **fetch succeeded**, **new suitable** and **already applied**. A log like `2 job boards; 0 skipped — no provider matched` means *zero boards were skipped* for lack of a provider, not that no providers exist.
- Old and duplicate applications are excluded even if they remain queued in an older SQLite database. An uncertain Submit should be treated as `submitted_unconfirmed` and never blindly retried.
- Some boards require an authenticated session; an interactive third-party CAPTCHA may be a job-specific blocker. Do not reach for HeadHunter, Telegram or sibling projects as a workaround.
- Real source APIs and form actions were not validated in this reconstruction; keep source modules under explicit live tests before claiming operational reliability.
