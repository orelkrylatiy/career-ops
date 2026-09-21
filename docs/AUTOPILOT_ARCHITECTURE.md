# Autonomous Web Worker Architecture

> Detailed source/API/browser research: [WEB_AUTOPILOT_RESEARCH.md](./WEB_AUTOPILOT_RESEARCH.md).

This document describes the fork-specific autonomous web application layer.

## Target system

~~~text
SOURCE CATALOG / COMPANY REGISTRY
          |
          v
DISCOVERY ENGINE
public API / ATS feed / RSS / XML / SSR HTML
browser extraction only where structured discovery is unavailable
          |
          v
NORMALIZED PIPELINE
          |
          v
AUTOPILOT SQLITE
exact dedup + explicit blacklist + soft ranking
          |
          v
ATOMIC PRIORITY QUEUE
          |
          v
CODING AGENT
read full JD -> choose/generate CV -> decide form answers
          |
          v
PLAYWRIGHT CLI
named persistent Chromium session/profile
          |
          v
REAL APPLICATION FORM
          |
          v
DETERMINISTIC SUBMIT VERIFIER
DOM + URL + validation + network + trace
          |
          v
APPLICATION JOURNAL / PROFILE ANALYTICS
          |
          v
NOTIFICATION OUTBOX -> TELEGRAM (optional, retryable)
~~~

## Responsibility boundaries

**Providers/scanners** answer: where are the jobs?

They should use structured network surfaces first because one request can enumerate many postings more cheaply and reliably than interactive browsing. These APIs are discovery-only: the current worker does not treat an ATS listing API as an application-submit API.

**Autopilot state/ranking** answers: what should the worker attempt next?

It does not decide that a weak match is forbidden. Preferences are priority signals.

**The LLM/coding agent** answers: how should this candidate apply to this particular job?

It reads the full JD, selects or generates a resume, interprets the form and controls the browser.

**Playwright CLI** is the browser interface.

There is no Career-Ops browser action DSL between the coding agent and Playwright.

**The verifier** answers: did the browser submission actually succeed?

It is deterministic and does not trust the agent's self-report.

## Discovery

The existing provider ecosystem remains the core collection layer.

~~~text
portals.yml + source-registry.db + catalog/source-catalog.yml
        |
        v
scan.mjs --wide / scan-regional.mjs
        |
        v
providers/*
        |
        +--> public API / JSON
        +--> RSS / XML / Atom
        +--> server-rendered HTML parser
        +--> browser extraction only when necessary
        |
        v
data/pipeline.md
        |
        v
autopilot.mjs
        |
        v
data/autopilot.db
~~~

`scan.mjs --wide` is deliberately different from the normal review-first scanner configuration. It bypasses preference/fit filters such as title, tier, location, configured posting age, salary, description/content, country eligibility and visa. Explicit CLI date bounds remain explicit.

It still keeps source safety checks, explicit blacklist behavior and canonical URL dedup.

In wide mode, company+title is not treated as posting identity: two independent requisitions may legitimately share the same title.

## Queue policy

Hard queue stops:

- invalid posting URL;
- exact/canonical posting already recorded;
- URL already present in the applications tracker;
- explicit company blacklist;
- explicit source blacklist.

Everything else can be queued.

`autopilot-ranking.mjs` produces a 0..100 priority from explainable signals such as:

- target-title similarity;
- negative-title hints;
- candidate country/city;
- remote wording;
- configured priority locations/sources;
- freshness.

A low score means "later", not "discard".

SQLite is authoritative. `data/autopilot-queue.md` is regenerated as an inspection surface.

## Atomic work claiming

Jobs now support:

- `priority`;
- `rank_reasons_json`;
- `posted_at`;
- `claimed_at`;
- `claim_owner`;
- `claim_until`;
- `next_attempt_at` for transient pre-submit backoff.

`node autopilot.mjs next --json` atomically leases the highest-priority queued job for 120 minutes by default. Expired leases are returned automatically, and the worker renews the lease immediately before arming Submit evidence.

This allows a single autonomous worker now and safe multi-worker expansion later.

## Browser

The first implementation uses **only Playwright CLI**.

Why:

- designed specifically for coding agents;
- compact, token-efficient commands;
- accessibility snapshots with stable refs;
- direct click/fill/select/check/upload;
- arbitrary `run-code` escape hatch;
- named browser sessions;
- persistent profiles;
- request/response inspection;
- traces and screenshots.

One initial worker should use:

~~~text
session: career-ops-worker-0
profile: data/browser-profile
browser: Playwright-managed Chromium (default; Chrome channel optional)
headed: yes while stabilizing
~~~

The profile is user/runtime data and must never be committed.

The worker processes many jobs in the same browser session. Parallel workers, when added later, must use separate sessions/profiles.

Browser Use, MCP and Computer Use are not part of the first production path. They can be reevaluated from measured failure data later rather than adding a second execution engine preemptively.

## Resume routing

Prepared resume variants remain configured under `autopilot.resumes`.

Target selection:

1. agent reads the full JD;
2. agent chooses the best prepared variant;
3. optionally generate a tailored CV for a useful/high-priority job;
4. use tailored PDF if generation and validation succeed;
5. otherwise fall back to the prepared selection;
6. deterministic `autopilot-resume.mjs` routing is the reliability fallback;
7. configured general/legacy PDF is the last fallback.

Resume generation failure never cancels an application.

## Submit evidence

`autopilot-verify.mjs` is not a browser controller. It attaches to the same Playwright CLI session before and after Submit.

### Before Submit

`begin`:

- probes live DOM;
- refuses to arm when obvious required/native-invalid controls remain;
- clears the CLI request log;
- starts tracing;
- captures before state/screenshot;
- creates a job-bound receipt.

### After Submit

`finish`:

- probes URL/DOM again;
- collects visible validation state;
- inspects post-clear network requests;
- inspects request/response bodies in memory for submit classification;
- persists only sanitized network metadata;
- captures after screenshot;
- stops trace;
- classifies the attempt.

### Outcomes

`applied`
: Explicit post-submit success state. This is the only browser outcome counted as confirmed.

`submitted_unconfirmed`
: A submit-like request or meaningful transition happened, but no explicit success state was proved. Do not auto-retry because it may already have submitted.

`validation_failed`
: Browser stayed in the form with validation errors/native invalid controls.

`blocked`
: CAPTCHA/human verification/anti-bot challenge.

`failed`
: Explicit failure state or failed submit-like request.

The LLM cannot promote an attempt to `applied` by assertion. `autopilot.mjs report ... applied --channel browser` requires a verified receipt for the same canonical job URL with outcome `applied`, and that receipt must have started after the current queue claim.

## Evidence/privacy

Local evidence lives under:

~~~text
data/autopilot/evidence/
~~~

Raw request/response bodies can contain PII and are inspected in memory only; they are not copied into SQLite/audit JSON.

Playwright traces may contain browser/request data and remain machine-local under `.playwright-cli/`.

The normal JSONL audit logger records lifecycle metadata, not form values/cookies/tokens.

## Application state

Canonical active/terminal states include:

~~~text
queued
claimed
applied
submitted_unconfirmed
validation_failed
failed
captcha
skipped
~~~

Legacy `test_filled` can still exist in old databases but is not part of the new autonomous flow.

Only confirmed `applied` increments the confirmed daily counter and writes the Applied tracker row.

Each application row can also carry a user-defined analytics `profile` (for example `frontend`, `mobile`, or `backend`). Profiles are labels only: they never become queue admission gates. The reporter accepts an explicit profile or deterministically resolves one from configured resume variants/title/stack keywords; unmatched applications remain visible as `unclassified`.

## Notification outbox

Telegram notifications are downstream of application state. When enabled for an outcome, `reportOutcome()` writes both the application row and a generic `notification_outbox` row in one SQLite transaction. The bot token/chat ID are never stored in SQLite. A separate delivery step atomically leases a due outbox row, calls Telegram and marks it sent; failures return to pending with exponential retry metadata. The lease prevents parallel application workers from concurrently sending the same notification.

This ordering is deliberate:

~~~text
verified application result
  -> SQLite application + outbox commit
  -> tracker/queue maintenance
  -> Telegram send (best effort)
  -> retry later if unavailable
~~~

Telegram can therefore fail without corrupting the application journal or causing a duplicate browser submission.

## Scheduling

Scheduling is outside the core loop.

A future scheduler starts the agent harness, not only `autopilot.mjs`.

Typical run:

~~~text
scheduler
  -> coding agent
  -> autopilot preflight
  -> wide scan + enqueue
  -> open persistent Playwright CLI session
  -> claim/apply/verify/report until queue empty
  -> exit
~~~

Discovery and application execution can later run as separate processes; atomic leases already prepare the state layer for that split.

## Submission channel

The production v1 submission channel is deliberately singular:

~~~text
coding agent -> Playwright CLI -> real web form -> deterministic evidence verifier
~~~

There is no `ats_api` application-report bypass. Greenhouse, Lever, Ashby, Workday, iCIMS and other structured APIs remain valuable for discovery, but an offer found through an API is still applied through its real web application surface.
