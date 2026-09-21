# Web Autopilot Research and Target Architecture

Status: implemented baseline + continuing source expansion  
Verified: 2026-09-21  
Scope: autonomous web job discovery and applications. Telegram/SMS/calendar/notification workflows are intentionally out of scope.

## Executive decision

Career-Ops should become a two-stage system:

~~~text
SOURCE CATALOG
ATS + job boards + aggregators + company career pages
        |
        v
DISCOVERY ENGINE
API / JSON / XML / RSS first
SSR HTML parser second
browser extraction only when necessary
        |
        v
NORMALIZED JOB DB
        |
        v
DEDUP + SOFT RANKING
almost everything survives
        |
        v
APPLICATION QUEUE
        |
        v
LLM APPLICATION AGENT
read full JD -> choose/generate CV -> build application context
        |
        v
PLAYWRIGHT CLI + DEDICATED PERSISTENT CHROME PROFILE
open -> snapshot/ref -> fill -> upload -> validate -> submit -> confirm
        |
        v
APPLICATION DB + LOGS + ANALYTICS
~~~

The most important policy is wide-funnel collection: ranking controls order, not eligibility. A weakly matching job should normally be attempted later rather than deleted early.

The browser should not be used to discover every job one page at a time. Discovery is primarily a data-engineering problem; browser automation is the last mile for application forms and the minority of sources without a stable structured feed.

Production v1 browser stack:

1. Playwright CLI is the only application-browser engine.
2. One named session uses one dedicated persistent browser profile; Playwright-managed Chromium is the default, with a system Chrome channel optional.
3. The coding agent drives the form directly with snapshots/refs and Playwright CLI commands.
4. A separate deterministic verifier decides whether Submit succeeded from DOM/URL/validation/network evidence.
5. Browser Use, Playwright MCP and Computer Use are deliberately deferred until measured failures justify another execution engine.

Why CLI first: Playwright's own coding-agent documentation explicitly positions playwright-cli as the lower-token option versus MCP. It avoids loading large tool schemas into the model context, uses concise commands, returns accessibility snapshots by file/reference, keeps a daemon-backed browser session alive between calls, supports arbitrary Playwright `run-code`, and exposes network/tracing commands needed by the verifier.

## 1. What already exists in this fork

The current migration is much closer to the target than a new project would be.

### Discovery

The repository currently contains 93 non-helper provider modules plus 10 shared provider helpers. The canonical detailed inventory already exists in docs/SUPPORTED_JOB_BOARDS.md.

Important existing provider families include:

- ATS: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee, Personio, Teamtailor, BambooHR, Breezy, iCIMS, Oracle Recruiting Cloud, Avature, Eightfold, Rippling, Jobvite, SuccessFactors, Phenom and others.
- Global/remote boards: Himalayas, Jobicy, Remotive, RemoteOK, Working Nomads, We Work Remotely, 4 Day Week, Hacker News Who is Hiring, CryptocurrencyJobs, NoDesk, Jobspresso and others.
- Europe: Arbeitnow, Welcome to the Jungle, JustJoin.it, No Fluff Jobs, Landing.jobs, The Hub, Arbeitsagentur, VDAB, GetManfred and others.
- Americas: Built In, The Muse, Get on Board, Job Bank Canada and ATS-hosted company boards.
- Asia/Africa: MyCareersFuture, Jobstreet/SEEK, Glints, Yourator, ITviec, CareerViet, Senjob and several large-company providers.
- Regional custom layer: Работа России, Staff.am, CareerCenter.am and ish.uz.

Existing useful components:

- catalog/source-catalog.yml: source and company-directory catalog.
- source-registry.mjs: persistent source/company/ATS resolution database.
- scan.mjs: canonical ingestion/normalization pipeline.
- scan-ats-full.mjs: reverse ATS sweeps for large sets of Greenhouse/Lever/Ashby/Workday/iCIMS boards.
- scan-regional.mjs: source-registry expansion plus canonical scanner.
- autopilot-db.mjs: autonomous job/application state.
- autopilot-resume.mjs: prepared-resume selection plus tailored-PDF fallback.
- autopilot-log.mjs: structured audit log.
- existing Career-Ops CV generation/verification/PDF pipeline.

### Russia-first company discovery already has a strong seed

catalog/source-catalog.yml already uses CNews500 2025 as a Russian IT-company directory, keeps all 500 companies and gives the first 200 higher priority.

That is a good seed and should remain. The 2025 CNews500 published in July 2026 covers 500 large Russian IT companies; CNews reports that the first 100 account for roughly 80% of the participants' combined revenue.

What is missing is a second broad-economy seed. Add RBC 500 as a complementary directory because large internal IT employers are not all IT vendors. RBC 500 includes major banks, retail, telecom, industrial, energy, transport and state-linked employers. The two lists should be normalized and deduplicated into the same company registry.

Target Russia company seeding:

~~~text
CNews500 -> all 500, first 200 priority
RBC500   -> all available companies, first 200 priority
user seeds / known tech companies
              |
              v
normalize company
              |
              v
find official career page
              |
              v
detect ATS / structured feed / local parser
              |
              v
persist resolved source in source-registry.db
~~~

The point is not to manually maintain 200 company URLs forever. We use rankings as company seeds, resolve each company once, persist its career endpoint, and then scan the resolved source cheaply every cycle.

## 2. Collection hierarchy

Every source should be assigned the cheapest reliable acquisition method.

| Tier | Acquisition | Use | Browser needed? |
| --- | --- | --- | --- |
| A | Public JSON/API/XML/RSS | Preferred for scanning | No |
| B | Public ATS career-site endpoint | Preferred for company boards | No |
| C | Stable server-rendered HTML | Custom/local parser | No |
| D | Browser extraction | JS-only/stateful source with no usable feed | Yes |
| E | Authenticated candidate API | Applicant-owned integrations such as HH/SuperJob | No for supported flows |
| F | Browser application | Actual employer/ATS application form | Yes |

Rule: never use an interactive browser to enumerate hundreds of jobs if the site itself exposes a structured feed that can return them in a few HTTP requests.

Browser fallback is source-local. A broken or blocked source does not stop the global scanner.

## 3. Russia source plan

### 3.1 Работа России: first-class API source

The official open-data API exposes all vacancies as JSON with GET requests.

Useful capabilities:

- all vacancies;
- employer-specific vacancies;
- lookup by INN/OGRN;
- region filters;
- text search;
- 100 records per page;
- up to 10,000 records in a query response window;
- modifiedFrom / modifiedTo incremental synchronization.

Recommended implementation: keep providers/trudvsem.mjs, but make incremental modified-date scanning the normal scheduled path. It is wasteful to recrawl the full national dataset each run.

Official docs:
https://trudvsem.ru/opendata/api
Documented API base:
http://opendata.trudvsem.ru/api/v1/vacancies

### 3.2 HeadHunter: highest-priority authenticated integration

HH has an official applicant API and is more valuable than browser scraping for Russia/CIS.

Verified capabilities:

- vacancy search and vacancy detail;
- applicant OAuth;
- applicant-specific vacancy fields;
- suitable resume list;
- negotiations/application history;
- POST application to a vacancy with a chosen resume and optional/required message.

Important fallback: HH documents a test_required error for vacancies where a test must be completed; those cannot currently be applied to through the application API. Direct/external vacancies can also hand off to an employer URL. Those cases go to the browser worker.

Target:

~~~text
HH API search
    |
    +--> normal HH vacancy -> candidate OAuth API apply
    |
    +--> test_required / external response_url -> browser queue
~~~

This should be one of the first new integrations after the architecture refactor.

Docs:
https://api.hh.ru/openapi/redoc
https://github.com/hhru/api

### 3.3 SuperJob: API-first once credentials are configured

SuperJob exposes a documented REST API. Registration/app credentials are required; requests use X-Api-App-Id and authenticated applicant actions use OAuth/Bearer authorization.

The API includes:

- vacancy search/details;
- user CVs;
- POST /2.0/send_cv_on_vacancy/ with id_cv, id_vacancy and optional comment.

Therefore SuperJob belongs in an authenticated plugin/connector layer rather than a brittle browser-only scraper. Browser remains a fallback when an API flow cannot represent a site-specific interaction.

Docs:
https://api.superjob.ru/

### 3.4 Habr Career

Habr Career has an official API, but an application must be registered and activated by Habr and configured for OAuth 2.0. In this research pass, candidate-side generic application submission was not verified well enough to make it a core assumption.

Plan:

- use the official API if/when the application is approved and the needed candidate endpoints are confirmed;
- otherwise keep public-page/browser discovery;
- use browser application for candidate submission unless a documented applicant endpoint is verified.

Docs:
https://career.habr.com/info/api
https://career.habr.com/info/legal/api_rules

### 3.5 Getmatch / GeekJob and other Russian boards

No stable first-party public candidate API was verified for Getmatch or GeekJob in this pass.

Treat them as:

1. public structured/SSR page parser when reliable;
2. browser discovery only when the page is JS/stateful;
3. browser application.

Do not pretend an unofficial internal endpoint is a stable API contract. If a public site endpoint is reverse-engineered, label it observed/undocumented and keep a browser/parser fallback.

### 3.6 Direct company career pages

For Russia, direct employer pages should be a major lane, not an afterthought.

For each CNews500/RBC500 company:

1. resolve the official careers URL;
2. detect whether it is Greenhouse, Lever, Workday, SmartRecruiters, Personio, iCIMS, SuccessFactors, Avature, proprietary SSR, etc.;
3. persist the resolution;
4. scan the ATS/feed directly forever after;
5. use generic browser application at the final apply URL.

This gets openings that may appear earlier or more completely than on aggregators.

## 4. ATS/API matrix

The key distinction is discovery API versus applicant submission API. Many ATS vendors expose jobs publicly but protect submission APIs with an employer/customer API key. We cannot generically use employer secrets as a job seeker, so browser submission remains the universal last mile.

| Platform | Public discovery | Public form schema | Generic applicant submit API usable by us? | Recommended path |
| --- | --- | --- | --- | --- |
| Greenhouse | Yes, Job Board API | Yes, job detail with questions=true | No. POST submission needs employer Job Board API key | API discovery/schema -> browser submit |
| Lever | Yes, Postings API | Partial; hosted form remains authoritative | No. POST needs API key created by employer Super Admin | API discovery -> browser submit |
| Ashby | Yes, public Job Posting API | Rich form schema exists in authenticated API | No. applicationForm.submit requires API key with candidatesWrite | Public API discovery -> browser submit |
| Workday | Observed public CXS JSON endpoint | Not a stable documented public form API | No generic candidate submit API identified | CXS discovery/detail -> browser submit |
| SmartRecruiters | Yes, public postings | Application configuration API exists | Protected; candidate_applications_manage/customer/partner auth | Public postings -> browser submit |
| Personio | Yes, public jobs XML feed | No generic public applicant schema | Recruiting application API requires company credentials/token | XML discovery -> browser submit |
| Teamtailor | Public jobs RSS; API with company key | API requires company-managed key | No generic applicant credential | RSS discovery -> browser submit |
| iCIMS | Public hosted portal can be parsed | Vendor Job Portal API is customer/auth-oriented | No generic applicant credential assumed | Parser/API where configured -> browser submit |
| Oracle Recruiting Cloud | Public candidate-experience resources exist per tenant | Tenant-specific candidate experience | No generic applicant credential assumed | Existing ORC provider -> browser submit |
| Workable | Public widget job feed | Hosted form | No generic applicant credential assumed | API discovery -> browser submit |
| Recruitee | Public offers API | Hosted form | No generic applicant credential assumed | API discovery -> browser submit |
| BambooHR/Breezy/Rippling | Public career feeds on many tenants | Hosted form | No generic applicant credential assumed | API discovery -> browser submit |

Official references:

Greenhouse:
https://docs.greenhouse.io/job-board.html

Lever:
https://github.com/lever/postings-api

Ashby:
https://developers.ashbyhq.com/docs/public-job-posting-api
https://developers.ashbyhq.com/reference/authentication
https://developers.ashbyhq.com/reference/applicationformsubmit

SmartRecruiters:
https://developers.smartrecruiters.com/docs/posting-api
https://developers.smartrecruiters.com/docs/application-api

Personio:
https://developer.personio.de/v1.0/reference/get_xml

Teamtailor RSS:
https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide

Workday note: the CXS endpoint is used by public Workday career SPAs and is already implemented by this repository, but it should be treated as an observed public career-site endpoint rather than a guaranteed external API contract. Keep tests and browser/detail fallbacks.

## 5. Global collection strategy

The global layer should combine two different approaches: direct ATS enumeration and board-wide aggregators.

### 5.1 Reverse ATS sweeps

scan-ats-full.mjs is strategically important. Instead of waiting for a company to be added manually, maintain/refresh board directories and sweep:

- Greenhouse;
- Lever;
- Ashby;
- Workday;
- iCIMS;
- then extend to other high-value tenant ATS families where a directory can be maintained safely.

This is especially useful for the US and Europe because many technology companies publish only on an ATS-hosted career site.

### 5.2 Remote/global APIs and feeds

High-value zero-auth sources already supported or suitable:

| Source | Interface | Notes |
| --- | --- | --- |
| Himalayas | Public JSON API | No auth; browse + filtered search; cursor pagination, max 20/page |
| Jobicy | Public JSON API | No key for normal listing URLs; up to 200 current jobs/request |
| We Work Remotely | Public RSS | All-jobs and category feeds |
| Remotive | Public API/RSS | Public API jobs are deliberately delayed about 24h; use as secondary source |
| 4 Day Week | Public JSON v2 | Filterable, documented 60 req/min; jobs refreshed a few times/day |
| Arbeitnow | Public JSON API | Europe-heavy, no API key |
| RemoteOK | Public API | Existing provider |
| Working Nomads | Public API | Existing provider |
| Hacker News Who is Hiring | Algolia/HN + parser | Existing provider |
| CryptocurrencyJobs | RSS | Existing provider |
| NoDesk / Jobspresso | RSS | Existing providers |

Official references:
https://himalayas.app/docs/remote-jobs-api
https://jobicy.com/jobs-rss-feed
https://remotive.com/remote-jobs/api
https://weworkremotely.com/remote-job-rss-feed
https://4dayweek.io/developers
https://www.arbeitnow.com/blog/job-board-api

### 5.3 Europe

Use existing providers rather than creating a new monolithic Europe scraper:

- Arbeitnow;
- Welcome to the Jungle;
- JustJoin.it;
- No Fluff Jobs;
- Landing.jobs;
- The Hub;
- Arbeitsagentur;
- VDAB;
- GetManfred;
- Personio/Teamtailor/Workday/SmartRecruiters/direct ATS pages.

### 5.4 Americas

Combine:

- Greenhouse/Lever/Ashby/Workday/iCIMS reverse sweeps;
- Built In;
- The Muse;
- Get on Board for LatAm;
- Job Bank Canada;
- Himalayas/Jobicy/WWR/RemoteOK/global feeds;
- direct company career pages.

### 5.5 Rest of world

Do not create a separate browser workflow per country. Keep the provider model.

Existing repository coverage already includes Singapore, Australia/New Zealand/SE Asia, China large-company careers, Taiwan, Vietnam, Armenia, Kazakhstan, Uzbekistan and some African sources. Add sources only when they materially add unique postings.

## 6. Make the source registry the control plane

source-registry.mjs already has the right core model:

- sources;
- companies;
- company_memberships;
- company_sources;
- health;
- resolved provider/ATS;
- runtime metadata.

It should become the discovery control plane.

The custom catalog currently has only a small global_sources list even though the upstream repo has 93 provider modules. Do not duplicate the full provider documentation into YAML manually. Instead:

- docs/SUPPORTED_JOB_BOARDS.md remains the human inventory;
- catalog/source-catalog.yml holds curated board-wide sources and company-directory seeds;
- source-registry.db holds resolved company career endpoints and runtime health;
- provider registry is the executable capability registry.

For each source record store at least:

- source id / name / region;
- provider;
- access mode: public-api, rss, xml, public-html, browser, oauth-api;
- discovered career URL;
- resolved ATS tenant/board id;
- last successful scan;
- last error/status;
- rate/cadence hints;
- source priority;
- terms/attribution notes where relevant.

## 7. Job database and queue

The normalized Job DB, not pipeline.md, should eventually be the source of truth. Markdown can remain a generated inspection surface.

Recommended job record:

~~~json
{
  "job_id": "stable internal id",
  "url_key": "normalized posting identity",
  "source": "hh|trudvsem|greenhouse|...",
  "source_job_id": "provider id",
  "ats": "greenhouse|workday|custom|...",
  "company": "Acme",
  "title": "Senior Frontend Engineer",
  "location": "Remote / Europe",
  "workplace_type": "remote|hybrid|onsite|unknown",
  "job_url": "posting url",
  "apply_url": "final application url",
  "description": "full normalized JD",
  "salary": {},
  "posted_at": "...",
  "discovered_at": "...",
  "last_seen_at": "...",
  "source_metadata": {},
  "priority": 0,
  "status": "queued"
}
~~~

### Wide-funnel rule

Hard rejection should be minimal.

Hard drop:

- exact/canonical duplicate;
- already successfully applied;
- posting confirmed dead/closed;
- explicit user/company blacklist;
- structurally invalid record with no usable target URL.

Normally do not hard-drop for:

- title mismatch;
- partial stack mismatch;
- seniority mismatch;
- location preference;
- salary mismatch;
- visa/sponsorship uncertainty;
- hybrid/onsite wording;
- years-of-experience mismatch.

Those are ranking/context signals. If the application eventually proves impossible, the browser worker records the actual reason.

### Ranking, not filtering

Priority can combine:

- Russia-first preference;
- direct company source versus duplicate aggregator copy;
- freshness;
- stack/title similarity;
- remote/worldwide wording;
- compensation;
- source quality;
- application friction;
- previous ATS success rate.

A score of 15 should mean "later", not "delete".

Suggested default ordering:

~~~text
fresh Russian direct-company / HH / Работа России
        >
fresh high-match worldwide remote
        >
Europe/global tech roles
        >
weak match / uncertain geography / high friction
~~~

But everything remains drainable.

This refactor is now implemented in the autonomous lane: `scan.mjs --wide` bypasses preference filters, provider-side location hints are disabled in wide mode, and `autopilot.mjs` uses those signals for priority instead of queue admission. Explicit blacklist/dedup/invalid-target rules remain hard stops.

## 8. Application packet handed to the agent

The LLM should not rediscover basic facts from the internet on every job. Discovery produces a job packet.

Minimum application packet:

~~~json
{
  "job": {
    "company": "...",
    "title": "...",
    "description": "...",
    "apply_url": "...",
    "ats": "...",
    "location": "...",
    "source": "..."
  },
  "candidate_profile": "structured profile facts",
  "resume_manifest": [
    {"id": "react", "path": "output/resumes/react.pdf"},
    {"id": "nextjs", "path": "output/resumes/nextjs.pdf"},
    {"id": "react-native", "path": "output/resumes/react-native.pdf"},
    {"id": "general", "path": "output/resumes/general.pdf"}
  ],
  "application_history": {
    "already_applied": false,
    "prior_attempts": []
  }
}
~~~

The agent prompt should be site-agnostic:

1. read the full job packet;
2. choose the best resume strategy;
3. open apply_url in the browser tool;
4. complete the form;
5. validate required state;
6. submit;
7. confirm success/failure;
8. return a structured result.

The job packet should stay site-agnostic. Browser-engine details belong in the autonomous agent mode/skill, so the discovery packet remains stable even if the browser implementation is reevaluated later.

## 9. Resume strategy

Keep the existing prepared-resume resolver, but change its role.

Target precedence:

1. LLM chooses the most useful prepared resume based on the full JD.
2. For a high-priority job, the agent may generate a tailored CV using the existing Career-Ops tailoring pipeline.
3. If tailored generation succeeds and the PDF validates, use it.
4. If generation fails, immediately fall back to the selected prepared resume.
5. If LLM selection fails, autopilot-resume.mjs deterministic keyword routing chooses a prepared variant.
6. Final fallback is general.pdf / legacy cv_pdf.

A CV-generation error must never kill an otherwise possible application.

The existing autopilot-resume.mjs already implements most of the deterministic fallback path and should be retained as reliability infrastructure.

## 10. Browser stack decision

### Default: Playwright CLI

For this project, the default browser interface should be `playwright-cli`, not MCP.

Playwright's current documentation explicitly distinguishes the two:

- CLI is aimed at coding agents working inside large repositories;
- CLI is more token-efficient because commands are concise and capabilities are learned through skills rather than large tool schemas;
- each action returns compact page metadata plus a link to an accessibility snapshot;
- element refs from snapshots avoid repeatedly inventing CSS selectors;
- a daemon keeps the browser alive between commands;
- named sessions isolate workers;
- `--persistent` or `--profile=<path>` keeps cookies/storage across browser restarts;
- the CLI can attach to an already running Chrome over CDP.

This maps directly onto our worker:

~~~text
Codex / Claude
      |
      v
playwright-cli
      |
      v
named persistent session
      |
      v
dedicated Chrome profile
      |
      v
ATS application form
~~~

Example shape:

~~~bash
PLAYWRIGHT_CLI_SESSION=career-ops-worker-0 <agent command>

playwright-cli -s=career-ops-worker-0 open "<apply_url>" --persistent
playwright-cli -s=career-ops-worker-0 snapshot
playwright-cli -s=career-ops-worker-0 click <ref>
playwright-cli -s=career-ops-worker-0 fill <ref> "<value>"
~~~

The exact shell syntax belongs in the agent skill, not in every application prompt.

Docs:
https://playwright.dev/docs/getting-started-cli
https://playwright.dev/agent-cli/introduction
https://playwright.dev/agent-cli/sessions
https://playwright.dev/agent-cli/commands/attach

### Why not Playwright MCP by default

MCP is still good, especially for agents built around structured tools and long exploratory browser loops. But Playwright's own docs state that MCP carries higher token/context cost because tool schemas and snapshots are presented through the MCP interface.

Our worker is already a coding agent with shell access. It does not need MCP just to click and fill a web form.

Use MCP only if a particular agent runtime handles MCP materially better than shell/skills or if structured tool invocation proves more reliable in measurement.

### Deferred browser alternatives

Browser Use/browser-harness, Playwright MCP and Computer Use were evaluated, but they are not part of the first production path.

The reason is architectural rather than a claim that they are weak tools: the worker first needs one measurable browser path. Playwright CLI already supplies snapshots/refs, direct form actions, arbitrary Playwright code, persistent sessions/profiles, network inspection and tracing. Adding a second engine now would duplicate browser lifecycle, success semantics, debugging, session storage and test coverage before we know which real failures require it.

If production evidence later shows a repeated class of forms that Playwright CLI cannot handle reliably, that evidence can justify a separate decision. Until then there is no browser fallback.

## 11. Browser profile/session design

Use one dedicated automation profile for the initial worker.

Do not use the user's normal Chrome default profile as the automation data directory. Give the worker its own persistent profile, for example:

~~~text
data/browser-profile/
~~~

or an equivalent Playwright MCP user-data-dir outside the git checkout.

Properties:

- persistent cookies/local storage/session;
- headed during development; headless can be enabled later per source;
- one browser owner per persistent profile at a time;
- one worker initially;
- process many application jobs in one long-lived browser session;
- restart the process on crash while preserving profile state;
- never commit cookies/profile files.

For future parallelism:

~~~text
worker-0 -> browser-profile-0
worker-1 -> browser-profile-1
worker-2 -> browser-profile-2
~~~

Playwright documents that one persistent profile cannot be owned by multiple browser instances concurrently. Separate profiles avoid lock/session corruption.

For login-required sources such as HH, the browser profile is a fallback/session store, while OAuth tokens for official candidate APIs belong in a separate secrets/credential layer.

## 12. Submission path: one browser channel in v1

There are two useful classes of API, but they have different roles in the implemented worker.

### Candidate-owned APIs

HeadHunter and SuperJob expose applicant-authorized APIs and are worth keeping in the source research because they can materially improve discovery and applicant context.

They are **not** a production submission channel in v1. The current worker deliberately keeps a single application execution path so success semantics, retries, evidence and debugging are not split between two engines.

### Employer-owned ATS APIs

Greenhouse, Lever, Ashby, SmartRecruiters, Personio and similar vendors expose submission APIs primarily for an employer's own career site or integration partner. They require employer/customer keys or permissions and are not generic applicant credentials.

For the implemented autonomous worker, both candidate/public APIs and employer ATS APIs are discovery/form-understanding inputs. Production submission is singular:

~~~text
posting discovered by API/feed/page
        -> coding agent
        -> Playwright CLI
        -> real candidate web form
        -> deterministic submit evidence
~~~

There is no `ats_api` reporting bypass in v1. A direct applicant-API channel can be reconsidered later only if it gets its own authentication, idempotency and deterministic receipt contract.

## 13. Pre-submit validation

The retired first-run/fill-only gate is replaced by universal pre-submit and post-submit verification on every browser application.

Before pressing Submit, verify as much as the browser surface exposes:

- application form is still present;
- required text/select/radio/checkbox/custom widgets have values;
- resume file is attached where required;
- no visible validation error;
- no required field known by structured ATS schema is missing;
- submit target is the real application action, not a navigation button.

After Submit:

- observe URL/page state;
- detect success/thank-you/application-received state;
- detect validation bounce and continue fixing if possible;
- record actual failure reason if blocked.

A new ATS is handled in the same real run when its form can be completed and verified. Correctness is based on observed form/network state, not a hardcoded site whitelist.

## 14. Scheduling model

Scheduling comes after the pipeline works, but the target is simple.

### Scanner

Run source-specific cadence, not one hammer interval for everything.

Suggested starting policy:

- high-value Russian APIs / major ATS feeds: every 15-30 minutes where terms/rate limits permit;
- ordinary company ATS boards: every 30-60 minutes;
- remote aggregators: hourly or according to their documented fair-use/update cadence;
- Remotive: a few times/day is sufficient because public API results are delayed;
- company directory refresh (CNews/RBC etc.): daily/weekly, not every scan;
- source health/resolution refresh: daily plus on failure.

Use conditional/incremental sync whenever the source supports it. Работа России modifiedFrom is the clearest example.

### Application worker

Independent process:

~~~text
while queue has jobs:
    claim next highest-priority job atomically
    build job packet
    run LLM + browser/API application
    record result
~~~

Discovery should continue independently while applications are being processed.

Later, multiple application workers can claim jobs with database leases and use separate browser profiles.

## 15. State and observability

Keep SQLite + JSONL, but make stages explicit.

Useful job/application events:

- discovered;
- normalized;
- queued;
- claimed;
- jd_loaded;
- resume_selected;
- resume_generated;
- browser_opened;
- form_started;
- resume_uploaded;
- submit_attempted;
- applied;
- validation_failed;
- login_required;
- captcha_or_block;
- closed;
- failed.

Useful analytics:

- discovered -> queued -> attempted -> submitted funnel;
- success rate by ATS;
- success rate by source;
- average application duration;
- failure reasons;
- selected resume variant;
- generated versus prepared resume;
- applications/day;
- queue age.

Do not log form secrets/session cookies. Logs should contain field names/state, not sensitive typed values.

## 16. Applied refactor

The autonomous web core now has these boundaries:

- no Telegram/SMS/calendar/notification workflow;
- no Telegram channel transport in autonomous `--wide` discovery;
- no email or ATS-API application-report bypass;
- title/negative-title/location/remote/salary/visa/content preferences are ranking signals rather than queue admission gates;
- SQLite priority queue is authoritative; pipeline markdown is an ingestion/view surface;
- one active lease per worker owner;
- old `test_filled` rows migrate back to `queued`;
- the retired browser-step and notification scripts are inert upgrade tombstones so older installations cannot keep executing stale implementations;
- Playwright CLI is the only v1 application browser engine;
- per-application `data/steps` recipes are not part of normal operation;
- deterministic evidence, not the LLM's self-report, controls `applied`.

Reusable ATS/browser knowledge should become deliberate tested code or agent guidance, never ad-hoc scripts created during each application.

## 17. Implementation status and next expansion

Implemented baseline:

- wide-funnel normalized SQLite queue with soft ranking and atomic leases;
- configured + regional + public ATS-directory/VC-seed deep discovery;
- Playwright CLI named persistent browser sessions (autonomous mode requires Node.js 20+);
- LLM-first resume choice with tailored/prepared fallback;
- deterministic pre/post-submit evidence and claim-safe finalization;
- browser-only autonomous submission channel;
- cross-platform CI and legacy DB/update migration coverage.

Next source work should expand **discovery coverage**, not introduce an unverified submit shortcut:

- deepen HeadHunter, SuperJob, Работа России and other regional/global feeds where their public/applicant APIs permit search;
- add/curate more of the existing provider catalog into the registry;
- improve career-page/ATS resolution and source-specific health/backoff;
- measure production browser failure classes before considering a second browser engine.

## 18. Concrete target after refactor

A normal cycle should look like this:

~~~text
[scanner]
CNews/RBC company seeds + Russia boards + ATS sweeps + global feeds
        |
        v
HTTP/API/RSS/XML/parser collection
        |
        v
normalized jobs / pipeline ingestion
        |
        v
dedup + soft priority
        |
[worker]
claim one queued job (SQLite lease)
        |
        v
load full JD + candidate context
        |
        v
LLM chooses prepared/tailored CV
        |
        v
named Playwright CLI session
persistent dedicated Chrome profile
        |
        v
fill -> validate -> renew lease -> arm verifier
        |
        v
real Submit click
        |
        v
post-submit DOM/URL/network verification
        |
        v
application DB + tracker + analytics
~~~

No manual browsing is required in the normal cycle. Human intervention is for initial account/OAuth login, genuinely human-only requirements, or repairing a provider when a source changes.

## 19. Research conclusions

1. The repository already has the hard part of discovery: a large provider ecosystem, ATS scanners and a persistent source registry. Reuse it.
2. Russia should be seeded by both IT-company and broad-employer directories, then resolved to direct career endpoints.
3. Работа России is an excellent open incremental API source.
4. HH and SuperJob are unusually valuable candidate-authorized APIs; prioritize them for discovery/context research, while keeping v1 submission browser-only.
5. Most global ATS APIs are excellent for public discovery but their submission endpoints use employer/customer credentials. Browser submission remains the generic solution.
6. Global collection should be API/feed heavy and browser light.
7. Do not filter the funnel aggressively. Dedup and known-impossible technical states are hard stops; fit signals are ranking.
8. Playwright CLI is the best default browser layer for this coding-agent workflow: Playwright explicitly positions it as the lower-token interface, with daemon sessions, accessibility refs, persistent profiles and CDP attach.
9. Do not add Browser Use/MCP/Computer Use fallback in v1. First measure Playwright CLI failure classes; add another engine only if the evidence shows a recurring gap that Playwright CLI plus `run-code` cannot solve.
10. One dedicated persistent automation Chrome profile is enough initially. Parallel workers require separate profiles.
11. The agent should receive a structured job packet and generic application prompt, not site-specific step scripts.
12. Telegram/SMS/notification features are outside the web-autopilot core and should not shape the architecture.

## Research references

Repository:
- docs/SUPPORTED_JOB_BOARDS.md
- catalog/source-catalog.yml
- source-registry.mjs
- scan.mjs
- scan-ats-full.mjs
- autopilot.mjs
- autopilot-resume.mjs
- docs/AUTOPILOT_ARCHITECTURE.md

Russia:
- Работа России API: https://trudvsem.ru/opendata/api
- HeadHunter API: https://api.hh.ru/openapi/redoc
- HeadHunter API repository: https://github.com/hhru/api
- SuperJob API: https://api.superjob.ru/
- Habr Career API rules: https://career.habr.com/info/legal/api_rules
- CNews500 2025: https://www.cnews.ru/reviews/rynok_it_itogi_2025/articles/cnews500_krupnejshie_it-kompanii_rossii
- RBC 500: https://pro.rbc.ru/rbc500

ATS:
- Greenhouse Job Board API: https://docs.greenhouse.io/job-board.html
- Lever Postings API: https://github.com/lever/postings-api
- Ashby public postings: https://developers.ashbyhq.com/docs/public-job-posting-api
- Ashby authentication: https://developers.ashbyhq.com/reference/authentication
- SmartRecruiters Posting API: https://developers.smartrecruiters.com/docs/posting-api
- SmartRecruiters Application API: https://developers.smartrecruiters.com/docs/application-api
- Personio XML feed: https://developer.personio.de/v1.0/reference/get_xml
- Teamtailor RSS: https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide
- Oracle HCM REST: https://docs.oracle.com/en/cloud/saas/human-resources/farws/

Global/remote:
- Himalayas API: https://himalayas.app/docs/remote-jobs-api
- Jobicy API/RSS: https://jobicy.com/jobs-rss-feed
- Remotive API: https://remotive.com/remote-jobs/api
- We Work Remotely RSS: https://weworkremotely.com/remote-job-rss-feed
- 4 Day Week API: https://4dayweek.io/developers
- Arbeitnow API: https://www.arbeitnow.com/blog/job-board-api

Browser:
- Playwright CLI for coding agents: https://playwright.dev/docs/getting-started-cli
- Playwright CLI introduction: https://playwright.dev/agent-cli/introduction
- Playwright CLI sessions/profiles: https://playwright.dev/agent-cli/sessions
- Playwright CLI attach/CDP: https://playwright.dev/agent-cli/commands/attach
- Playwright MCP (optional alternative): https://playwright.dev/docs/getting-started-mcp
- Browser Harness (evaluated, deferred): https://github.com/browser-use/browser-harness
- Browser Use coding-agent setup (evaluated, deferred): https://browser-use.com/coding-agents
