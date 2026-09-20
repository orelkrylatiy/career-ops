# Autonomous Worker Architecture

This document describes the **fork-specific** autonomous job-search layer. The upstream Career-Ops modes remain review-first; the fork's `autopilot` mode is an explicit opt-in worker.

## Mental model

- **Codex / Claude Code / another coding agent is the brain.** It reads the queue, job description, profile and mode instructions, then decides the next action.
- **Career-Ops is the toolkit and state layer.** It discovers jobs, filters them, stores queue/state, resolves resumes, records outcomes and exposes deterministic commands.
- **Playwright/Chrome is the hands.** The agent drives the application form through `autopilot-browser.mjs`.
- **cron/systemd/launchd/Task Scheduler is the clock.** Career-Ops does not secretly install its own scheduler.

## Discovery flow

```text
portals.yml + source registry
        |
        v
scan.mjs / scan-regional.mjs
        |
        v
provider adapters (Greenhouse, Lever, Workday, regional sources, ...)
        |
        v
public API / HTML feed
        |
        v
normalized jobs
        |
        v
title/location/blacklist/dedup gates
        |
        v
data/pipeline.md -> data/autopilot-queue.md + SQLite
```

A provider is an adapter that knows how one job source exposes listings. Discovery normally uses HTTP/API calls because that is cheaper and more reliable than opening every careers site in a browser. Browser extraction/liveness is used where a source needs it.

## Application flow

1. Run `node autopilot.mjs preflight`.
2. Run `node autopilot.mjs` to refresh the queue.
3. Start `node autopilot-browser.mjs serve` for a long-lived browser page/context.
4. For each queued job, the agent opens the posting, confirms it is live, and archives the JD.
5. The agent resolves a resume with `autopilot-resume.mjs`.
6. It fills the real employer/ATS form from `config/profile.yml` + `cv.md`, uploads the selected PDF and observes the result after every meaningful action.
7. A **new site/form type is fill-only** and is reported as `test_filled`. A previously validated channel may be submitted automatically by the opt-in autopilot.
8. Every job ends with `node autopilot.mjs report ...`, which updates SQLite, the tracker and the queue.

The scanner APIs are not application-submit APIs. The normal application channel is the real browser. `ats_api` is a reporting channel label unless a source-specific direct-submission implementation actually exists.

## Browser lifetime

`autopilot-browser.mjs serve` keeps one Playwright persistent context alive and accepts local commands over loopback. This preserves live SPA/wizard state between actions. It has an idle watchdog and exits after 30 minutes without commands.

The profile directory under `data/browser-profile` persists cookies/login state across browser processes. A persistent profile does **not** mean Chrome must run forever.

Use `AUTOPILOT_TAG` to isolate parallel workers into separate profiles/state files.

## Multi-resume routing

Configure prepared variants in `config/profile.yml`:

```yaml
autopilot:
  cv_pdf: "output/resumes/general.pdf"   # legacy/final fallback
  resumes:
    prefer_generated: true
    fallback: general
    variants:
      react-native:
        file: "output/resumes/react-native.pdf"
        title_keywords: ["react native", "mobile"]
        keywords: ["react native", "expo", "ios", "android"]
        priority: 30
      nextjs:
        file: "output/resumes/nextjs.pdf"
        title_keywords: ["next.js", "nextjs"]
        keywords: ["next.js", "nextjs", "app router", "server components"]
        priority: 20
      react:
        file: "output/resumes/react.pdf"
        title_keywords: ["frontend", "react"]
        keywords: ["react", "typescript", "javascript"]
        priority: 10
      general:
        file: "output/resumes/general.pdf"
        keywords: []
```

Selection precedence:

1. explicitly requested prepared variant;
2. an existing tailored/generated PDF supplied by the agent;
3. best matching prepared variant using title + JD text;
4. configured fallback variant;
5. legacy `autopilot.cv_pdf`.

If tailored generation fails or its expected file is missing, passing that path as `--generated` automatically falls back to a prepared resume. Paths are restricted to `output/` or `data/`.

Examples:

```bash
node autopilot-resume.mjs validate
node autopilot-resume.mjs select --title "Senior React Native Engineer" --jd-file data/autopilot/jds/job.md --json
node autopilot-resume.mjs select --variant nextjs --json
node autopilot-resume.mjs select --generated output/tailored/acme.pdf --title "Frontend Engineer" --jd-file data/autopilot/jds/acme.md --json
```

## State, logs and analytics

Queryable state lives in `data/autopilot.db`:

- `jobs`: lifecycle per posting;
- `applications`: every attempt, channel, ATS, selected resume and duration;
- `events`: structured worker events;
- `contacts`, `llm_calls`, `daily_state`.

Human-readable audit events are appended to:

```text
data/autopilot/logs/YYYY-MM-DD.jsonl
```

The audit logger intentionally redacts form values, credentials, tokens, email/phone fields and answers.

The browser keeps the latest machine-readable state and screenshot at:

```text
data/browser-state.json
output/browser-state.png
```

Useful commands:

```bash
node autopilot.mjs status
node autopilot.mjs logs --limit 50
node autopilot.mjs analytics
```

Report metadata explicitly so later analytics can explain what happened:

```bash
node autopilot.mjs report "<url>" applied \
  --channel browser \
  --ats greenhouse \
  --resume react-native \
  --resume-path output/resumes/react-native.pdf \
  --duration-ms 84213 \
  --note "success page confirmed"
```

Do not put personal form values or secrets in `--note`.

## Scheduling

A scheduler should start the **agent harness**, not only `autopilot.mjs`, if unattended applications are desired. Running `autopilot.mjs` alone discovers/queues work but does not provide the reasoning loop that fills forms.

A typical unattended run is:

```text
scheduler -> Codex/Claude worker -> scan/queue -> browser serve -> jobs -> report -> exit
```
