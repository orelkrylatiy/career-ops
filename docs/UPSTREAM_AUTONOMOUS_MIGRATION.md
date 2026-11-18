# CareerOps 1.40.0 upstream integration (autonomous fork)

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

## Verification gap

The connector migration cannot run a persistent authenticated Chromium profile
or submit a live application. Those runtime checks must occur on the user's host.
