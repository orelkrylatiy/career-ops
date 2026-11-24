# Autonomous application mode (fork extension)

**Scope:** optional browser application runner layered over unchanged upstream Career Ops. This is an operator contract, not a live campaign status file. Ordinary upstream `apply` remains review-first and never submits on its own. Do not infer that a running campaign is paused or authorized solely from this document.

[CAPTCHA handling](./CAPTCHA.md) · [Russian and international sources](./REGIONAL_SOURCES.md) · [isolated profiles](./PROFILES.md) · [architecture](./AUTOPILOT_ARCHITECTURE.md)

## What the extension does

The original Career Ops scans ATS systems and job boards, evaluates postings, generates resumes and maintains the Markdown tracker. Our opt-in extension provides a SQLite lease-based queue and a browser worker that uses the same authorized Playwright CLI session, chooses a verified CV, fills a real application, and requires a receipt from `autopilot-verify.mjs` before it can mark a submission verified.

The worker **does not** run in ordinary upstream modes. Autopilot is **paused by default**; a user instruction in the current session to send applications is the authorization for that run, but the runner still requires `AUTOPILOT_LIVE=1`, preflight, and the explicitly chosen `CAREER_OPS_ROOT`. Never hard-code a fixed campaign quota, market minimum or technology stack in repository policy: the user's current request and the selected direction determine these. Old, duplicate and ambiguous sends never count.

## Starting from Codex (same entrypoint as upstream)

Open the checkout and start Codex normally:

```bash
cd ~/projects/career-ops
codex
```

The upstream skill router at `.agents/skills/career-ops/SKILL.md` is used for standard modes; this fork additionally routes **explicit autonomous submission requests** to `autopilot`. Plain prompts such as "Run the Career Ops scan mode" use upstream `scan`; "Fill this application" uses review-first `apply`; an explicit "send N applications for the selected profile" uses the fork-only Autopilot **after current-session authorization, profile selection and preflight**. Simply starting Codex does not begin a campaign. If the skill is not auto-discovered, ask Codex to run `career-ops autopilot` by name; do not improvise manual browsing or broad vacancy searches.

The selected candidate and direction live under the User Layer, not `AGENTS.md` or a permanent script default. Confirm the exact active profile with `node profile.mjs list` and `node profile.mjs env <candidate> <direction>` before any runner starts. Do not launch two runners for one direction or discard local changes while updating.

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
# After selecting exact CAREER_OPS_ROOT, prove a browser can open/snapshot WITHOUT applications:
node autopilot-runner.mjs --browser-check
npm run autopilot:dry-run
```

The contact preflight requires a real `candidate.email` and an existing prepared PDF. It extracts email-like text from the header of `cv.md` and the first page of the fallback PDF using `pdftotext`. An email differing from `candidate.email` is a **warning by default**, not a submission blocker: applicants may legitimately use different addresses for their application form and CV. The operator is responsible for making sure both addresses belong to the intended candidate and receive replies. To opt into the stricter legacy rule, set `autopilot.require_email_match: true` in the selected direction's `config/profile.yml`; this blocks mismatches again. Neither setting logs the actual email addresses in the diagnostic.

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

## When doctor says OK but Playwright startup fails

`node autopilot-verify.mjs doctor` validates the local CLI installation; it does **not** prove that Chromium launches under the current Codex sandbox, uses the right profile or can snapshot. Do not start a live run just because doctor says `ok: true`.

After exporting the exact selected profile, run `node autopilot-runner.mjs --browser-check` with **no** `AUTOPILOT_LIVE` required. This opens only `about:blank` when necessary, preserves an already-open named session, and prints the specific failing Playwright CLI command (`open` or `snapshot`), its exit code and sanitized stderr. It does not scan, claim jobs or submit anything. If the error mentions a busy profile, check for a surviving browser/daemon before closing it; never delete the browser profile, cookies, or session data as a first fix. A failure related to sandbox/cache permissions needs the candidate-scoped `XDG_CACHE_HOME`/writable path; a Chrome executable alone does not prove the launch works.

The user-local script printed by `npm run autopilot:live` is also a version fingerprint: if it still expands to `node autopilot-runner.mjs --no-scan`, the checkout has not yet received this branch's updated wrapper. Check `git status --short` and the current `git log -1` before updating; never overwrite uncommitted browser changes.

## Candidate/direction isolation

A **candidate** can have independent directions (for example React, Next.js or Vue). `node profile.mjs add-profile <candidate> --name Candidate` registers a new person, and `node profile.mjs add-direction <candidate> <direction> --name Direction` creates a direction. Use `node profile.mjs env <candidate> <direction>` to print its data-root and browser-session exports. Apply them in the shell **before** preflight or live operations. Do not recreate existing directions.

Each direction has a different `portals.yml`, `config/profile.yml`, resume selection, `data/applications.md`, `data/autopilot.db` and Playwright session. Mixing roots silently causes wrong-CV applications and tracker duplicates.

## Source discovery versus application

Provider adapters are for finding jobs, **not** evidence that a particular site can submit a form. Available fork-specific boards include Habr Career, GeekJob and SuperJob. Full upstream international ATS and board adapters remain present.

The live runner first considers existing SQLite queued jobs. **For a Frontend/Web direction**, it no longer requires exact `title_filter` matches before leasing: a broad, deterministic role-family triage retains UI/Web/Full-stack and ambiguous Software Engineer titles, while a worker reads the **FULL JD** to determine the actual frontend duties, stack and hard eligibility. A missing React/Next.js keyword or a preferred framework alone never rejects a position. Queue priorities are recalculated in memory for the current direction without rewriting 20k+ historical statuses or priorities. For other directions the old exact title gate stays unless explicitly disabled.

If no eligible jobs remain, the runner performs **one time-bounded scan of configured sources**, then stops if still empty. For the inferred Frontend/Web wide funnel, the fork adapter calls the unchanged upstream scanner with its `--wide` option to avoid prematurely losing possible frontend listings; setting `autopilot.wide_funnel: false` uses original scanner filters instead. Ordinary upstream scan/`apply` remain unchanged. This is NOT a full ATS sweep: the runner never automatically launches deep discovery. Explicit `--no-scan` disables all discovery and `--no-scan-on-empty` disables fallback. `AUTOPILOT_REGIONAL=off` suppresses optional RU sources but does not add or remove worldwide job eligibility. `autopilot.priority_market: Russia` enables an optional local boost; otherwise there is **no Russia-first bias**.

Before any live run, inspect the queue read-only:

```bash
node autopilot.mjs queue-diagnose
```

The JSON output shows eligible counts, role-family tiers, exclusion reasons and top five candidates without claiming, scanning, opening a browser or submitting. A resulting `eligible: 0` now distinguishes absent frontend role families from explicit blacklists and filters. On-demand discovery examples:

```bash
# Run only after choosing the correct profile/root.
# To scan configured sources without launching live application workers:
node autopilot-scan.mjs
# If the current profile requests Russian sources:
node source-registry.mjs export --country RU
CAREER_OPS_PORTALS="$CAREER_OPS_ROOT/data/portals-regional.generated.yml" node autopilot-scan.mjs
# Explicit reverse-ATS discovery, not part of the normal application loop:
npm run autopilot:full-scan
# To resume a previous matching sweep:
npm run autopilot:full-scan -- --resume
```

For a deliberate **initial configured-source scan** within the runner, pass `--scan`; `npm run autopilot:live` does not hardcode `--no-scan`, and the parser rejects conflicting flags. Normal queue-first execution performs at most one bounded, configured-source scan only when no eligible jobs remain; its Autopilot-only Frontend/Web wide-funnel option does not alter the upstream scanner or activate a full ATS sweep. Avoid repeatedly scanning an existing large queue. Deep ATS discovery requires the separate `npm run autopilot:full-scan` command; the live runner deliberately ignores old `AUTOPILOT_DISCOVERY=full` environment values; `autopilot:full-scan` now keeps upstream filters and its normal posting-date defaults, rather than silently enabling `--wide --include-undated`. If an unfinished checkpoint exists, the adapter refuses to overwrite it without explicit `--resume` or `--resume-if-compatible` (the latter may start fresh on mismatch). Ordinary operation needs neither discovery mode.

## Application workflow and safety

The runner checks primary cv.md/profile contact consistency, probes installed coding-agent login (auto-falling back to another authenticated CLI) and Playwright startup, then leases one job, reads the JD, checks candidate fit/eligibility and previous tracker records, selects a verified PDF, fills the form in an authorized session, calls `autopilot-verify.mjs begin` before Submit and `finish` after, then records `applied` **only** with matching evidence. A click alone is not proof.

The worker uses the exact project-local Playwright CLI entrypoint with the same named browser session; no temporary symlink or global `playwright-cli` is required. Preflight compares the selected profile email to primary cv.md and, when the local `pdftotext` utility can extract the first PDF page, checks the prepared resume PDF contact too. If PDF text extraction is unavailable, it prints an explicit warning: the worker must still verify the exact PDF it uploads. No contact email is logged in a mismatch diagnostic.

Other possible outcomes: `submitted_unconfirmed`, `captcha`, `validation_failed`, `failed`, `skipped`, or a deferred lease. Never retry ambiguous submissions automatically. A site-specific blocker must not switch the worker to `tg-ops`, `hh-ops`, Telegram contacts, or a different profile. HeadHunter and Telegram are excluded.

For optional email-based authentication, `autopilot-mail.mjs wait` only reads recent, independently verified OTP messages when Gmail OAuth is configured. Never bypass MFA, consent, or website restrictions. Optional `humanizer-bridge.py` checks should not block simple forms when unavailable.

For supported text-image CAPTCHAs, the agent attempts bounded OCR only where permitted; unresolved reCAPTCHA/hCaptcha/Turnstile are reported as job-specific blockers rather than forced bypasses. See [CAPTCHA](./CAPTCHA.md).

## Live start (requires explicit authorization in the current session)

```bash
# After the user explicitly authorizes this live campaign in the current conversation,
# export the direction and execute preflight/live in this SAME shell:
CANDIDATE_ID="your-candidate-slug"   # choose from: node profile.mjs list
DIRECTION_ID="your-direction-slug"   # choose from: node profile.mjs list
eval "$(node profile.mjs env "$CANDIDATE_ID" "$DIRECTION_ID")"
node autopilot.mjs preflight
AUTOPILOT_LIVE=1 npm run autopilot:live -- --agent codex --max-jobs 3
# An explicitly approved campaign can set a goal AND a separate attempt ceiling:
# AUTOPILOT_LIVE=1 npm run autopilot:live -- --agent codex --target-applied 5 --max-jobs 20  # illustrative limits
```

The live runner takes an exclusive per-direction lock at `<CAREER_OPS_ROOT>/data/autopilot/live-runner.lock` before preflight/browser work. A second live process for the same direction fails safely instead of sharing Chromium; distinct candidate roots can run separately. After an abnormal machine/process kill, the lock may remain: verify the recorded PID and any ambiguous submission before manually removing a stale lock. Do not force-clear an active runner.

Defaults: existing eligible queue, one bounded configured-source scan only if no eligible jobs remain, at most five claimed jobs per run (not five successful submissions), ten minutes per worker. `--target-applied N` stops after N new verified submissions in this run; `--max-jobs M` independently bounds attempts. A goal alone never overrides the attempt cap. `--scan` and `--no-scan` are mutually exclusive. When the runner processes a large queue it skips repeated full Markdown queue exports (`AUTOPILOT_QUEUE_MIRROR=off`); SQLite is authoritative, and `autopilot-queue.md` may be stale until a manual export or scan refresh. Increasing the cap or performing a full/wide/undated scan is always deliberate. The one configured-source recovery scan is the documented default, unless explicitly disabled. Use a restricted OS account or container: CLI flags and `AGENTS.md` are not a filesystem security boundary.

## Verification and known limitations

The committed GitHub workflow checks JS syntax, contract tests and a **local-only fake-form** browser E2E. It cannot verify live Habr/GeekJob/SuperJob login, dynamic forms, access restrictions or real successful submissions. Verify those only with a separate authorized test plan. See [fork rebuild notes](./FORK_REBUILD.md).

Direct `node autopilot.mjs next` and `node autopilot.mjs report` are also gated by `AUTOPILOT_LIVE=1`; this avoids accidental bypass of the runner's paused-campaign rule. Codex is started with `workspace-write`, one explicit `--add-dir` for the selected direction and an explicit network setting needed for application forms. Network access does not prevent prompt injection or unsafe navigation: use a real OS/container boundary.
