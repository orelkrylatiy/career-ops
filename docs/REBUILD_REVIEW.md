# Career Ops rebuild — engineering review (2026-11-21)

## Source verification
- Direct full upstream base: `career-ops-hq/career-ops` `e1c0c1c2cb4e271fb83540dd6cdf3ac943509243`.
- Restored own RU/CIS providers, regional catalog, multi-profile manager, browser agent, SQLite queue, receipt verifier, CAPTCHA text-image workflow and optional Gmail/Humanizer.
- Original upstream code preserved. Only 19 unwanted root-level translated READMEs deleted; Russian *runtime search data* intentionally remains.
- Previous main protected at `backup/main-pre-upstream-rebuild-20261121`; draft PR #6 remains an additional source.

## Defects found and corrected
- Stale Telegram tombstone test imported a deleted module: converted to an explicit absence test.
- Runner and operator docs had contradictory live activation / scanning commands: fixed and documented in English.
- Direct `autopilot.mjs next` and `report` bypassed paused campaign: now both require `AUTOPILOT_LIVE=1`.
- Tracker reconciliation and explicit `strict_market` are enforced before dispatch; HH/Telegram URLs are excluded.
- Codex worker can write the selected data root via `--add-dir`; browser networking is explicitly enabled in workspace-write, not danger-full-access.
- Old main contained profile-specific Humanizer voice selection and safe file-based JSON transfer absent in PR #6: restored them. A dedicated regression test covers profile-specific voice data.
- Kept PR #6's safer quarantine of expired leases, CAPTCHA model configuration, RU priority and log redaction.
- Original `modes/registration.md` was *not* copied because it contained personal candidate data and obsolete one-off instructions.

## Static review
- Relative module imports were checked across the transferred JS modules and tests. A removed Telegram import was identified and corrected.
- The fork-specific test script includes 28 test files; the workflow also invokes upstream lint and quick test-suite checks plus a local fake browser form.
- English README, autonomous, CAPTCHA, regional-source, profile and migration docs are linked. Source identifiers and OCR patterns remain in Cyrillic as required for Russian job sites.
- Default operation is non-submitting; live applications are expressly paused until user reactivates them.

## Unverified — require runtime execution before production use
- `npm install` with native SQLite, complete `npm run autopilot:test` and `npm run lint`.
- `node test-all.mjs --quick`, Chromium setup and local fake-form Playwright E2E.
- Real current Habr, GeekJob and SuperJob login, job discovery, CAPTCHA response and successful application confirmation.
- Local profile migration: per-direction CV/profile/portals/tracker/SQLite/browser sessions.
- Full filesystem confinement. AGENTS.md and CLI sandbox options do not fully prevent reading sibling projects. An OS/container boundary remains necessary.

GitHub Actions has reported **0 new runs** for this branch. Static review must not be represented as green CI or production approval. Do not run live applications, count historic submissions or resubmit uncertain attempts solely because the branch is merged.

## Recovery
Use `backup/main-pre-upstream-rebuild-20261121` to inspect the previous main version. Avoid `git reset --hard` or deleting a direction root while unbacked-up user data exists. Files that contained personal data in previous public commits remain in Git history until separately audited.
