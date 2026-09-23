# Profiles & Directions — multi-account career-ops

One checkout can run job searches for **several people**, each in **several
specializations**, without anything leaking across boundaries.

```
profile (a person's account — one Telegram user)          profiles.yml
└── direction (a specialization: analyst, designer,
    react, vue, …as many as you like)
    ├── data/          own tracker, scan history, autopilot.db
    ├── reports/       own evaluation reports + report numbering
    ├── config/        own profile.yml
    ├── portals.yml    own portal list
    ├── cv.md          own CV
    └── data/browser-profile   own browser (cookies, logins)
```

A direction's directory is a **full career-ops data root**: export it as
`CAREER_OPS_ROOT` and every existing script — `stats.mjs`, `scan.mjs`,
`autopilot.mjs`, `set-status.mjs`, `doctor.mjs` — relocates into it. That is
the whole isolation mechanism; there is no second code path.

## Setup

```bash
# 1. A profile per person (get the Telegram id from @userinfobot)
node profile.mjs add-profile maxim --name Maxim --tg 123456789 --admin

# 2. A direction per specialization — creates the isolated data-root skeleton
node profile.mjs add-direction maxim analyst --name "Data Analyst"
node profile.mjs add-direction maxim designer --name "Designer"
node profile.mjs add-direction maxim react   --name "React Developer"

# 3. Fill the direction like a fresh checkout: paste its CV into
#    data/profiles/maxim/analyst/cv.md, edit config/profile.yml, then
#    (with the env below applied) run node doctor.mjs and follow it.
```

The registry (`profiles.yml`, user layer, gitignored) also drives bot access:
one Telegram id → one profile; `--admin` sees every profile.

## Running a direction (isolated browser included)

```bash
node profile.mjs env maxim analyst      # print the exports…
# export CAREER_OPS_ROOT="data/profiles/maxim/analyst"
# export AUTOPILOT_WORKER_ID="maxim-analyst"
# export AUTOPILOT_BROWSER_SESSION="career-ops-maxim-analyst"

node profile.mjs launch maxim analyst   # …and the browser command
# npx playwright cli -s=career-ops-maxim-analyst open "about:blank" \
#   --profile="data/profiles/maxim/analyst/data/browser-profile" --headed --browser=chrome
```

Apply the exports in the shell where you run career-ops for that direction
(evaluation, scan, autopilot). Each direction gets its own persistent browser
profile and Playwright session, its own autopilot worker id (SQLite claim
owner) and its own report numbering — parallel directions in parallel browsers
do not collide, per `docs/AUTOPILOT_ARCHITECTURE.md`'s worker rules.

Relative `CAREER_OPS_ROOT` values resolve against the **code root** (see
`path-resolver.mjs`), so the printed exports work from any cwd.

## Telegram bot

```bash
# .env: TG_BOT_TOKEN=… (create the bot with @BotFather)
npm run bot            # = node tg-bot.mjs
```

Whoever writes to the bot is identified by Telegram id against `profiles.yml`
— unknown ids are denied (and told their id to forward to an admin). Known
users get **their own** numbers:

- `/start` — menu: 📊 Моя статистика · 🧭 Направления · 🕘 Последние отклики · ℹ️ Кто я
- `/stats` — profile roll-up: how many directions exist, applications/responses/interviews/offers summed, conversion rates recomputed from the sums
- `/dirs` → tap a direction — its tracker, statuses, funnel, scan totals
- `/last` — newest tracker rows across the profile's directions
- `/profiles` (admin) — every profile with its numbers
- `/about` — the product story: how it works, terms, privacy
- `/ping` — liveness

### Onboarding & the sales funnel (pre-login surface)

An **unknown** visitor is a lead, not an error. `/start` shows the pitch —
the same claims the landing page makes, no more (без предоплаты, оплата от
результата, персональная статистика) — with two buttons:

- **📋 Как это работает** → the full story: the 4 steps, terms (50% от оффера
  при хотя бы одном собеседовании через процесс), the honest no-guarantee
  disclaimer, the privacy note (no access to personal messages).
- **🚀 Получить доступ** → every admin in `profiles.yml` gets a message with
  the visitor's name, @username, Telegram id and a ready-to-paste
  `node profile.mjs add-profile <slug> --name "Имя" --tg <id>` command; the
  visitor sees a toast and the lead is appended to `data/tg-bot-leads.json`
  (one request per id — repeats don't spam admins).

Data commands (`/stats`, `/dirs`, …) stay deny-by-default for unknown ids —
only the pitch, `/about` and the access request are public.

Stats come from `stats.mjs`'s canonical contract (`computeAllStats`) with
explicit per-direction file paths — the same math as `node stats.mjs`, zero
LLM cost. All routing/rendering is pure and offline-testable
(`lib/tg-bot-core.mjs`); `tg-bot.mjs` only polls and executes. One process per
bot token (Telegram rejects a second poller with 409). The update offset is
persisted to `data/.tg-bot-state.json` so restarts don't replay.

Offline check without a token:

```bash
node tg-bot.mjs --dry-run updates.json   # fixture in, Bot API calls out
```

## Rules of thumb

- **Agents working a direction** must keep its env applied for every command;
  read personalization (`cv.md`, `modes/_profile.md`, `config/profile.yml`)
  from the direction root, not the checkout root.
- **`node profile.mjs stats`** shows the same numbers locally the bot shows in
  Telegram.
- Removing a direction keeps its data; `--purge` deletes the root.
- The checkout's own root (no env) remains a fully working single account —
  profiles are additive.
