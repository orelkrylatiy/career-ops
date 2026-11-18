# CareerOps 1.40.0 upstream integration (autonomous fork)

> **User-facing documentation:** [AUTOPILOT_RU.md](./AUTOPILOT_RU.md) · [CAPTCHA_RU.md](./CAPTCHA_RU.md) · [RU_SOURCES.md](./RU_SOURCES.md). This file is a technical migration log; operational setup belongs in the linked guides.

This integration branch uses the upstream career-ops-hq/career-ops main tree at commit
`18e114599c2b830daa962afe798f518212733c46` (2026-11-18), retaining its
web dashboard, providers, employer registry, privacy guard, updater and tests.

## Boundaries

- `npm run autopilot` explicitly opts into the fork-specific autonomous application workflow.
- Default upstream apply/email/web-preview workflows remain review-first.
- Neither Telegram transport nor HeadHunter integration is part of this workflow.
- `autopilot-scan.mjs` supplies upstream scanners a temporary configuration
  with preference filters stripped. It never edits the user's portals.yml.
- Queue ranking is soft. Exact duplicate checking, destination validation and
  the explicit blacklist remain hard boundaries.
- A click alone never counts as applied: deterministic submit evidence is required.
  Submitted-but-unconfirmed attempts are quarantined against duplicate retries.
- CAPTCHA does not stop the overall run. Attempt ordinary text-image challenges
  with the local vision solver and continue to the next job when this fails.
  No token spoofing, MFA bypass or anti-bot evasion.
- Candidate facts come only from the user's trusted CV and profile.

## Commands

Install on a supported Node version, install dependencies and the Playwright
Chromium browser, and ensure an authorized coding CLI is available.

    npm run autopilot:preflight
    npm run autopilot:dry-run
    npm run autopilot -- --agent codex --max-jobs 3
    npm run autopilot:status
    npm run autopilot:captcha:detect
    npm run autopilot:test

To test against a local fixture use the existing autopilot browser test rather
than real jobs. Do not merge until upstream and fork CI are green and a single
real-job workflow has been evaluated in an isolated user environment.

## Update safety and discovery

The upstream updater's `apply` command is intentionally guarded in this
fork: its manifest does not own the additional autonomous modules and would
overwrite the fork's entry points. Sync future upstream versions through
reviewed merge commits, not through the vanilla self-updater.

By default the runner scans both user-configured boards and modern upstream
reverse ATS directories. Set `AUTOPILOT_DISCOVERY=configured` to restrict
network discovery to already-configured sources, or use
`AUTOPILOT_ATS_SINCE_DAYS=7` to reduce the reverse-scan window.

If a single worker exits without reporting a verified outcome, that job is
quarantined and the runner continues. After three consecutive worker failures
a circuit breaker stops the run to avoid exhausting the queue during an agent
outage. CAPTCHA failures with recorded job-specific status do not trip it.

## Verification gap

The connector migration cannot run a persistent authenticated Chromium profile
or submit a live application. Those runtime checks must occur on the user's host.

## Russian job sites and source activation

The fork has first-party source adapters for Habr Career, GeekJob and
SuperJob; Armenia and Uzbekistan providers are included as separately
scoped sources. Their presence in `providers/` is not enough to activate
discovery: the runner now exports the `source-registry.mjs` Russian catalog
and scans its generated portals file in addition to the user's configured
employers and upstream ATS feeds. The ordinary regional export uses the published catalog; `--refresh-registry`
asks the runner to invoke the `full --country RU` registry workflow (a slower,
network-dependent sync/verify/enrich/resolve/export cycle).

- `AUTOPILOT_REGIONAL=off`: skip the curated RU catalog (opt out).
- `AUTOPILOT_DISCOVERY=configured`: skip the broad ATS-directory scan, but
  continue configured and regional scans.
- `AUTOPILOT_ATS_SINCE_DAYS=14`: default lookback for reverse ATS scanning.
- The app avoids HeadHunter and Telegram in the autonomous scan adapter, but
  dormant upstream provider modules remain present in the imported codebase.

**No live-provider guarantee:** the individual Russian sites can change HTML,
restrict APIs, require authentication, or implement anti-bot challenges. A
module and a source entry are not evidence of live successful submissions.

## CAPTCHA: capabilities and configuration

The included `captcha-solver.mjs` supports image-to-text CAPTCHA in a
Playwright CLI session. It detects a matching image and input, captures the
challenge image, calls the already-configured OpenCode vision model (or an
explicit `CAPTCHA_OPENCODE_MODEL`), falls back to an OpenAI-compatible
`OPENAI_API_KEY` / `CAPTCHA_VISION_MODEL`, types the recognized text and
checks the normal page response. Five attempts is the default, clamped to
eight by the solver. `AUTOPILOT_CAPTCHA_ATTEMPTS` controls the worker's
requested attempt count.

No module or service named **MGS** is installed: this is a vision OCR
approach, not a hidden third-party CAPTCHA-solving service. It does not
automatically defeat SmartCaptcha, reCAPTCHA, hCaptcha, Turnstile, device
attestation or second-factor checks. Where an acceptable local method
cannot complete the form, the worker records a job-level CAPTCHA outcome
and continues with other jobs instead of waiting for a human.

For an unattended local job run, Gmail verification is optional and
requires valid GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN.
That is a separate provider from the normal CareerOps Gmail plugin. Missing
credentials mean email OTP/registration flows cannot be completed
autonomously on sites that require them.

## Manual test order before release

1. Configure a real local candidate profile (candidate email, truthful CV,
   prepared resume PDF path/variants), local portals.yml and a browser profile.
2. Install Node and native SQLite dependencies; verify selected coding agent.
3. Run `npm run autopilot:test` and `npm run autopilot:dry-run`.
4. Run a fixture-only browser smoke test with Playwright.
5. On the actual workstation, verify the RU source registry export, inspect
   sample search results, complete a pre-authorized one-job test.
6. Review pending, applied, CAPTCHA-blocked and unconfirmed statuses and
   confirm that the same vacancy was never submitted twice.

The integration branch has not been runtime-tested on the user's workstation,
and an unverified site submission must never be described as successful.

## Headless server deployment and restored local profiles

`npm run autopilot` now opens Playwright Chromium **headlessly by default**,
which does not require an X server. Set `AUTOPILOT_BROWSER_HEADED=1` when a
graphical desktop is available and a visible browser is explicitly preferred.
A saved dedicated browser session is reused, and the same session name is
shared with the CAPTCHA and evidence verifier.

The fork's local profiles/directions manager is restored as
`npm run profile -- ...` (also `node profile.mjs ...`), without mandatory
Telegram identifiers. The original optional Telegram metadata field is only
read for legacy registry compatibility and is not a transport. Read
`docs/PROFILES.md` to isolate multiple candidate tracks and their cookies.

The old fork also contained a Telegram-focused landing, mail utilities and
other experimental artifacts that are deliberately **not** part of this
upstream-first integration. This preserves the autonomous job-applying core,
not exact parity with every non-core file from the old fork.
