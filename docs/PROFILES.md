# Local profiles and career directions

> Start here: [Autopilot operator guide](./AUTOPILOT.md). This manager isolates local candidate accounts without requiring Telegram.

CareerOps can isolate several candidates or specialization tracks on one
machine, without Telegram or HeadHunter.

Create a candidate and add a direction:

```bash
node profile.mjs add-profile candidate --name "Candidate"
node profile.mjs add-direction candidate developer --name "Developer"
node profile.mjs env candidate developer
```

Apply the emitted environment variables **in the same shell** before running
`npm run autopilot`. On Linux/bash you can do:

~~~bash
# Execute the printed export statements in this shell
eval "$(node profile.mjs env candidate developer)"

npm run autopilot:preflight
npm run autopilot:dry-run  # no submissions
# For an explicitly reactivated campaign only:
# AUTOPILOT_LIVE=1 npm run autopilot:live -- --agent codex --max-jobs 1
~~~

Each direction receives its own CareerOps data root,
profile.yml, portals.yml, SQLite queue, tracker, reports and Playwright browser
session. Configure the candidate's actual email and truthful CV in that
direction before running preflight; nothing copies secret credentials from
another profile.

Use `node profile.mjs list` and `node profile.mjs stats` to inspect. For
browser login, `node profile.mjs launch candidate developer` prints a local
Chromium launch command; to execute it add `--run` **on a machine with a graphical desktop** (the command uses headed Chromium); the normal autonomous runner is headless on a VPS. An already running login
profile may be reused by the autonomous runner inside the same direction.

The registry retains a legacy optional `telegram` field when reading
pre-existing profiles.yml for compatibility, but the CLI does not request or
use Telegram identifiers or bot tokens. All user registries are kept in the
local data root, not in Git.


## Multiple candidates and switching directions

The registry has two independent levels:

- **Candidate**: one real person with their own identity and work history.
- **Direction**: React, Next.js, Vue or another specialty for that same person.

For example, create two people with distinct directions, once:

```bash
node profile.mjs add-profile alice --name "Alice"
node profile.mjs add-profile bob --name "Bob"
node profile.mjs add-direction alice react --name "React"
node profile.mjs add-direction alice vue --name "Vue"
node profile.mjs add-direction bob nextjs --name "Next.js"
```

Every direction has its own CV, identity configuration, trackers, SQLite queue,
browser cookies and named Playwright session. Reusing a session across
candidates is prohibited; each person must submit only verified personal facts.

To switch from Alice to Bob in the **same shell**, apply the whole environment
block returned by `profile.mjs env`, not merely `CAREER_OPS_ROOT`:

```bash
eval "$(node profile.mjs env alice react)"
npm run autopilot:dry-run
eval "$(node profile.mjs env bob nextjs)"
npm run autopilot:dry-run
node profile.mjs list --json
```

The exported `CAREER_OPS_PROFILE_STORE_ROOT` and `CAREER_OPS_PROFILES`
keep the shared registry anchored to the original data store while
`CAREER_OPS_ROOT` changes to a person's particular direction. Do not leave
stale `CAREER_OPS_PROFILE`, `CAREER_OPS_PORTALS`, `CAREER_OPS_TRACKER`,
`CAREER_OPS_AUTOPILOT_DB` or `AUTOPILOT_BROWSER_PROFILE` overrides
pointing at another candidate.

An autonomous campaign processes **one selected direction per runner**; it
does not automatically cycle over everyone in the registry. Multiple people
can run separate authorized campaigns, but browser sessions, data roots
and job-claim workers must stay distinct. A person with multiple directions
may see the same vacancy in more than one queue: check their combined
application history before any second submission.

The live campaign remains paused; dry-run and profile commands do not send
applications.

## Live worker and mailbox identity checks

Live autonomous runs require an explicit `AUTOPILOT_BROWSER_SESSION` and
`AUTOPILOT_WORKER_ID`, supplied together by `node profile.mjs env`.
The runner validates that both belong to the exact candidate/direction
registered under `CAREER_OPS_PROFILE_STORE_ROOT`. It rejects profile,
portals, tracker, SQLite and browser overrides that point outside that
direction's root. A missing shared registry is an error for managed
`data/profiles/<person>/<direction>` paths, not a reason to guess the identity.

The Gmail OTP helper validates the OAuth Gmail mailbox address against the
active `config/profile.yml` candidate email **before reading verification
messages**. An OAuth token for Alice cannot silently read Bob's login codes.
Each person must configure their own authorized mailbox credentials in their
own process environment. Gmail aliases and forwarded addresses need
deliberate configuration rather than an implicit identity bypass.

The optional legacy `gmail-api.mjs` transport also defaults its OAuth files to the selected direction's `data/gmail/` directory. When migrating an older shared local Gmail store, set `CAREER_OPS_GMAIL_DIR` to a candidate-specific directory inside the selected direction only. The API checks the connected Gmail identity before reading or sending; no hard-coded machine-specific mailbox path is used.

## Persistent browser profiles and custom storage paths

Playwright CLI normally keeps the login only in memory. Career Ops always
opens a **persistent** Playwright profile by passing `--profile=<absolute path>`.
This saves login cookies and browser site storage across restarts. The named
`-s=<name>` session identifies which currently running browser to control,
but is not itself a durable on-disk account.

Default location for Alice's React direction:
`<PROFILE_STORE>/data/profiles/alice/react/data/browser-profile`.

You may instead provide a custom browser storage directory on another disk.
Set **one dedicated browser store root outside the repository**; Career Ops
appends `<candidate>/<direction>` and will not reuse another person's folder:

```bash
export CAREER_OPS_BROWSER_STORE_ROOT="/mnt/private/career-ops-browsers"
eval "$(node profile.mjs env alice react)"
# AUTOPILOT_BROWSER_PROFILE=/mnt/private/career-ops-browsers/alice/react
# AUTOPILOT_BROWSER_SESSION=career-ops-alice-react
# PLAYWRIGHT_CLI_SESSION=career-ops-alice-react
node profile.mjs launch alice react
# To actually open the visible browser for manual sign-in:
node profile.mjs launch alice react --run
```

Windows PowerShell:

```powershell
$env:CAREER_OPS_BROWSER_STORE_ROOT="D:\\PrivateBrowsers\\CareerOps"
node profile.mjs env alice react --shell powershell
# Apply the printed $env: assignments, then:
node profile.mjs launch alice react --run
```

The following now derive the **same absolute profile folder**:
`profile.mjs env`, `profile.mjs launch`, `profile.mjs launch --run`,
the autonomous runner's browser preflight, and verifier/CAPTCHA modules.
For one direction you may manually override `AUTOPILOT_BROWSER_PROFILE`
with a path **inside its own data root**. External paths must be generated
through `CAREER_OPS_BROWSER_STORE_ROOT` and the candidate/direction IDs.

Cookies, IndexedDB and localStorage are confidential credentials.
Do **not** use the regular Chrome or Edge user-data directory for Playwright:
use a dedicated browser profile, and never launch two Chromium processes
against one user-data directory concurrently. Back up this private folder
only while its browser is closed. Existing Chrome windows can sometimes
be attached through CDP or a browser extension, but this fork's autonomous
runner does **not** implement that as its normal execution mode.

Reusing the same browser profile normally preserves login until the site
expires or revokes the session. A separate, approved login may still be
necessary after that; persistence does not bypass site protections.

When an authorized browser session is already open, the runner checks its snapshot and reuses it rather than opening a second Chromium process or resetting the current page. If it is closed, it opens the configured persistent directory. **Before changing CAREER_OPS_BROWSER_STORE_ROOT or moving profile folders, close that named browser session, update the environment, and relaunch.** Otherwise an already-open session can still reference the old location; do not move an active Chrome profile.
