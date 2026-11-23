# Autonomous application mode (fork extension)

**Scope:** optional browser application runner layered over unchanged upstream Career Ops. This is an operator contract, not a live campaign status file. Ordinary upstream `apply` remains review-first and never submits on its own. Do not infer that a running campaign is paused or authorized solely from this document.

[CAPTCHA handling](./CAPTCHA.md) · [Russian and international sources](./REGIONAL_SOURCES.md) · [isolated profiles](./PROFILES.md) · [architecture](./AUTOPILOT_ARCHITECTURE.md)

## What the extension does

The original Career Ops scans ATS systems and job boards, evaluates postings, generates resumes and maintains the Markdown tracker. Our opt-in extension provides a SQLite lease-based queue and a browser worker that uses the same authorized Playwright CLI session, chooses a verified CV, fills a real application, and requires a receipt from `autopilot-verify.mjs` before it can mark a submission verified.

The worker **does not** run in ordinary upstream modes. Autopilot is **paused by default**; a user instruction in the current session to send applications is the authorization for that run, but the runner still requires `AUTOPILOT_LIVE=1`, preflight, and the explicitly chosen `CAREER_OPS_ROOT`. Never hard-code a 30-application quota, Russian-market minimum or React/Next/Vue target in repository policy: the user's current request and the selected direction determine these. Old, duplicate and ambiguous sends never count.

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

The browser binary and profile directory are **different paths**. Browser/CLI cache defaults to the selected direction's `data/autopilot/browser-cache` through `XDG_CACHE_HOME`, so sandboxed workers do not need to write in the global `~/.cache`; `AUTOPILOT_CACHE_DIR` optionally chooses another cache path. The preflight creates the directory before launching Chromium. The runner
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

By default, a live runner **processes an existing queue**, without performing a new scan. A requested scan keeps upstream's filters; only explicit wide-scan commands remove soft preferences. The runner also applies upstream's exact configured `title_filter` to historical SQLite queue entries **before invoking a browser worker**, so previously collected unrelated roles do not consume a Codex invocation. Explicit discovery steps:

```bash
# Run only after choosing the correct profile/root.
node source-registry.mjs export --country RU
npm run autopilot:wide-scan
# The expanded regional portals can also be scanned explicitly:
CAREER_OPS_PORTALS="$CAREER_OPS_ROOT/data/portals-regional.generated.yml" npm run autopilot:wide-scan
```

For on-demand discovery within the live runner, pass `--scan`; do not pass it together with `--no-scan`. Avoid repeated full discovery when the existing queue is enormous. For deep ATS enumeration, also set `AUTOPILOT_DISCOVERY=full`. Ordinary use needs neither.

## Application workflow and safety

The runner checks primary cv.md/profile contact consistency, probes installed coding-agent login (auto-falling back to another authenticated CLI) and Playwright startup, then leases one job, reads the JD, checks candidate fit/eligibility and previous tracker records, selects a verified PDF, fills the form in an authorized session, calls `autopilot-verify.mjs begin` before Submit and `finish` after, then records `applied` **only** with matching evidence. A click alone is not proof.

The worker uses the exact project-local Playwright CLI entrypoint with the same named browser session; no temporary symlink or global `playwright-cli` is required. A prepared PDF is still subject to a factual/contact review before actual submission: this static preflight compares profile.yml to primary cv.md, not extracted PDF text.

Other possible outcomes: `submitted_unconfirmed`, `captcha`, `validation_failed`, `failed`, `skipped`, or a deferred lease. Never retry ambiguous submissions automatically. A site-specific blocker must not switch the worker to `tg-ops`, `hh-ops`, Telegram contacts, or a different profile. HeadHunter and Telegram are excluded.

For optional email-based authentication, `autopilot-mail.mjs wait` only reads recent, independently verified OTP messages when Gmail OAuth is configured. Never bypass MFA, consent, or website restrictions. Optional `humanizer-bridge.py` checks should not block simple forms when unavailable.

For supported text-image CAPTCHAs, the agent attempts bounded OCR only where permitted; unresolved reCAPTCHA/hCaptcha/Turnstile are reported as job-specific blockers rather than forced bypasses. See [CAPTCHA](./CAPTCHA.md).

## Live start (requires explicit authorization in the current session)

```bash
# After the user explicitly authorizes this live campaign in the current conversation,
# and after exporting the chosen direction's environment:
AUTOPILOT_LIVE=1 npm run autopilot:live -- --agent codex --max-jobs 3
# A larger explicitly approved campaign can set a goal AND a separate attempt ceiling:
# AUTOPILOT_LIVE=1 npm run autopilot:live -- --agent codex --target-applied 30 --max-jobs 120
```

Defaults: existing queue, at most five claimed jobs per run (not five successful submissions), ten minutes per worker. `--target-applied N` stops after N new verified submissions in this run; `--max-jobs M` independently bounds attempts. A goal alone never overrides the attempt cap. `--scan` and `--no-scan` are mutually exclusive. When the runner processes a large queue it skips repeated full Markdown queue exports (`AUTOPILOT_QUEUE_MIRROR=off`); SQLite is authoritative, and `autopilot-queue.md` may be stale until a manual export or scan refresh. Increasing the cap or performing a scan is always deliberate. Use a restricted OS account or container: CLI flags and `AGENTS.md` are not a filesystem security boundary.

## Verification and known limitations

The committed GitHub workflow checks JS syntax, contract tests and a **local-only fake-form** browser E2E. It cannot verify live Habr/GeekJob/SuperJob login, dynamic forms, access restrictions or real successful submissions. Verify those only with a separate authorized test plan. See [fork rebuild notes](./FORK_REBUILD.md).

Direct `node autopilot.mjs next` and `node autopilot.mjs report` are also gated by `AUTOPILOT_LIVE=1`; this avoids accidental bypass of the runner's paused-campaign rule. Codex is started with `workspace-write`, one explicit `--add-dir` for the selected direction and an explicit network setting needed for application forms. Network access does not prevent prompt injection or unsafe navigation: use a real OS/container boundary.
