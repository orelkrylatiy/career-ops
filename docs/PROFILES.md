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
