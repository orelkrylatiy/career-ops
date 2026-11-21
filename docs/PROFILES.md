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
