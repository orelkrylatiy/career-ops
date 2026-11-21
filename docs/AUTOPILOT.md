# Autonomous application mode (fork extension)

**Status:** rebuild on the full upstream Career Ops as of 2026-11-21. This document describes the optional fork-specific browser application runner, not the upstream review-first `apply` mode. No real jobs or site CAPTCHAs were exercised in this rebuild.

[CAPTCHA handling](./CAPTCHA.md) · [Russian and international sources](./REGIONAL_SOURCES.md) · [isolated profiles](./PROFILES.md) · [architecture](./AUTOPILOT_ARCHITECTURE.md)

## What the extension does

The original Career Ops scans ATS systems and job boards, evaluates postings, generates resumes and maintains the Markdown tracker. Our opt-in extension provides a SQLite lease-based queue and a browser worker that uses the same authorized Playwright CLI session, chooses a verified CV, fills a real application, and requires a receipt from `autopilot-verify.mjs` before it can mark a submission verified.

The worker **does not** run in the ordinary upstream modes. This campaign (30 new verified frontend applications, at least 10 in the Russian market) remains **paused** until the user explicitly resumes it. Old, duplicate or uncertain sends are not part of the campaign. The runner has a hard `AUTOPILOT_LIVE=1` activation gate and an explicit `CAREER_OPS_ROOT` requirement.

## Install and inspect without submissions

Use Linux, a compatible Node release (`package.json` requires Node ^22.13.0 or >=23.4.0), Python only if optional Humanizer is configured, and one signed-in agent CLI (Codex, Claude, or OpenCode). Browser interaction uses Playwright CLI and either a selected local browser executable or the CLI default.

```bash
npm install
npx playwright install chromium
npm run lint
npm run autopilot:test
node profile.mjs list
npm run autopilot:status
npm run autopilot:preflight
npm run autopilot:dry-run
```

Never publish `cv.md`, `config/profile.yml`, browser profiles/cookies, Gmail OAuth tokens, screenshots, or local SQLite files. Do not copy example identity information into real applications.

## Browser binary and saved login (Linux)

```bash
export AUTOPILOT_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
# Optional: absolute profile directory, defaults to selected direction's data/browser-profile.
# export AUTOPILOT_BROWSER_PROFILE=/srv/career-ops/browser-state/react
eval "$(node profile.mjs env candidate react)"
node profile.mjs launch candidate react        # prints exact command; no browser started
# node profile.mjs launch candidate react --run # GUI login only, desktop required
```

The browser binary and profile directory are **different paths**. The runner
validates that the configured executable is absolute, exists and is executable.
It passes `PLAYWRIGHT_MCP_EXECUTABLE_PATH` to Playwright CLI rather than relying
on the upstream browser-launch helper used for other flows. The upstream
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is accepted as fallback. If a specified
binary is unavailable, do not fall back to another. A login saved in the
persistent Playwright profile is reused in the same direction/session.
`profile.mjs env` pins the parent registry and base root so subsequent
`profile.mjs launch` commands do not accidentally nest direction paths.
Close/restart a named session after changing profile or browser binary; do not
reuse a currently open personal Chrome profile. Linux/bash only in this fork's
autonomous/profile-manager tools. The original upstream `apply` flow remains
separate and unchanged.

## Candidate/direction isolation

A **candidate** can have independent **React**, **Next.js** and **Vue** directions. `node profile.mjs add-profile candidate --name Candidate` registers a new person, and `node profile.mjs add-direction candidate react --name React` creates a direction. Use `node profile.mjs env candidate react` to print its data-root and browser-session exports. Apply them in the shell **before** preflight or live operations. Do not recreate existing directions.

Each direction has a different `portals.yml`, `config/profile.yml`, resume selection, `data/applications.md`, `data/autopilot.db` and Playwright session. Mixing roots silently causes wrong-CV applications and tracker duplicates.

## Source discovery versus application

Provider adapters are for finding jobs, **not** evidence that a particular site can submit a form. Available fork-specific boards include Habr Career, GeekJob and SuperJob. Full upstream international ATS and board adapters remain present.

By default, a live runner **processes an existing queue**, without performing a new scan. Explicit discovery steps:

```bash
# Run only after choosing the correct profile/root.
node source-registry.mjs export --country RU
npm run autopilot:wide-scan
# The expanded regional portals can also be scanned explicitly:
CAREER_OPS_PORTALS="$CAREER_OPS_ROOT/data/portals-regional.generated.yml" npm run autopilot:wide-scan
```

For on-demand discovery within the live runner, pass `--scan`. For deep ATS enumeration, also set `AUTOPILOT_DISCOVERY=full`. Ordinary use needs neither.

## Application workflow and safety

The runner preflights, probes the agent login and Playwright startup, leases one job, reads the JD, checks candidate fit/eligibility and previous tracker records, selects a verified PDF, fills the form in an authorized session, calls `autopilot-verify.mjs begin` before Submit and `finish` after, then records `applied` **only** with matching evidence. A click alone is not proof.

Other possible outcomes: `submitted_unconfirmed`, `captcha`, `validation_failed`, `failed`, `skipped`, or a deferred lease. Never retry ambiguous submissions automatically. A site-specific blocker must not switch the worker to `tg-ops`, `hh-ops`, Telegram contacts, or a different profile. HeadHunter and Telegram are excluded.

For optional email-based authentication, `autopilot-mail.mjs wait` only reads recent, independently verified OTP messages when Gmail OAuth is configured. Never bypass MFA, consent, or website restrictions. Optional `humanizer-bridge.py` checks should not block simple forms when unavailable.

For supported text-image CAPTCHAs, the agent attempts bounded OCR only where permitted; unresolved reCAPTCHA/hCaptcha/Turnstile are reported as job-specific blockers rather than forced bypasses. See [CAPTCHA](./CAPTCHA.md).

## Explicitly authorized live start (not currently approved)

```bash
# After the user explicitly resumes this paused campaign,
# and after exporting the chosen direction's environment:
AUTOPILOT_LIVE=1 npm run autopilot:live -- --agent codex --max-jobs 3
```

Defaults: existing queue, at most five jobs per run, ten minutes per worker. Increasing the cap or performing a scan is always deliberate. Use a restricted OS account or container: CLI flags and `AGENTS.md` are not a filesystem security boundary.

## Verification and known limitations

The committed GitHub workflow checks JS syntax, contract tests and a **local-only fake-form** browser E2E. It cannot verify live Habr/GeekJob/SuperJob login, dynamic forms, access restrictions or real successful submissions. Verify those only with a separate authorized test plan. See [fork rebuild notes](./FORK_REBUILD.md).

Direct `node autopilot.mjs next` and `node autopilot.mjs report` are also gated by `AUTOPILOT_LIVE=1`; this avoids accidental bypass of the runner's paused-campaign rule. Codex is started with `workspace-write`, one explicit `--add-dir` for the selected direction and an explicit network setting needed for application forms. Network access does not prevent prompt injection or unsafe navigation: use a real OS/container boundary.
