# Scripts layout for the RU fork

Этот каталог — дом для **нового fork-specific executable code**.

## Почему мы не переносим все upstream `.mjs` из корня прямо сейчас

В upstream `career-ops` flat root — намеренное архитектурное решение, а не случайный беспорядок. Имена вроде `scan.mjs`, `tracker.mjs`, `generate-pdf.mjs` используются:

- `update-system.mjs` / `SYSTEM_PATHS`;
- package scripts;
- tests;
- workflows;
- docs и examples;
- community forks/plugins;
- import paths между root-модулями.

Массовый `mv *.mjs scripts/...` без compatibility migration сломает обновление upstream и большое количество путей одновременно.

Поэтому сейчас делаем две вещи:

1. **логически раскладываем существующие root scripts по областям**, чтобы было понятно, что где искать;
2. весь **новый код нашего форка** сразу кладём в нормальную тематическую структуру.

Если позже решим, что чистая структура важнее лёгкого merge с upstream, physical migration делаем отдельным epic с wrappers и full test suite.

---

## Новая структура

```text
scripts/
  README.md

  discovery/
    # source orchestration, normalization/dedup helpers

  integrations/
    # source-specific integrations: hh/, telegram/, custom career sites

  actions/
    # future apply/outreach executors

  ops/
    # scheduler, backfill, health/diagnostics, migration helpers

  lib/
    # shared fork-owned code

  check-syntax.mjs       # existing upstream script
  export-ats-text.mjs    # existing upstream script
```

### `scripts/discovery/`

Код, который связывает несколько sources и common pipeline:

```text
run discovery
normalize source item
source summary
cross-source dedup/merge
```

Source-specific network code сюда не кладём — он идёт в `integrations/` или существующие upstream `providers/`.

### `scripts/integrations/`

Внешние системы и их adapters.

План:

```text
scripts/integrations/
  hh/
  telegram/
  browser/
```

Смысл adapter: получить данные внешней системы и вернуть их в common contract. Он не решает сам, откликаться ли на вакансию.

### `scripts/actions/`

Будущий execution layer:

```text
HH apply
ATS form fill
recruiter outreach
result verification
```

Discovery не импортирует action code.

### `scripts/ops/`

Operational tooling:

```text
scheduler
backfill
health checks
source diagnostics
migration scripts
```

### `scripts/lib/`

Только reusable fork-owned helpers. Не превращаем `lib/` в свалку: helper должен использоваться минимум в двух местах или быть самостоятельным abstraction boundary.

---

# Logical map существующих root scripts

Это карта, а не предложение физически перемещать их сегодня.

## Discovery / sources

```text
scan.mjs
scan-ats-full.mjs
scan-hn.mjs
scan-interamt.mjs
discover-ats.mjs
verify-ats.mjs
verify-portals.mjs
validate-portals.mjs
audit-portals.mjs
check-liveness.mjs
liveness-api.mjs
liveness-browser.mjs
liveness-core.mjs
dead-boards.mjs
portal-health-lock.mjs
detect-reposts.mjs
fetch-jd.mjs
jd-capture.mjs
browser-extract.mjs
url-key.mjs
user-agent.mjs
```

Новые public/no-auth ATS adapters продолжают жить в upstream-style `providers/`.

## Pipeline / tracker / state

```text
add-entry.mjs
archive-posting.mjs
dedup-tracker.mjs
find.mjs
merge-tracker.mjs
normalize-statuses.mjs
pipeline-lock.mjs
rank-pipeline.mjs
reconcile-pipeline.mjs
reserve-report-num.mjs
set-status.mjs
tracker.mjs
tracker-links.mjs
tracker-parse.mjs
tracker-sync-check.mjs
tracker-utils.mjs
verify-pipeline.mjs
```

## Evaluation / matching / analytics

```text
analyze-patterns.mjs
calibrate.mjs
classify-tier.mjs
company-funded.mjs
company-history.mjs
discard-analytics.mjs
eval-golden.mjs
funnel-velocity.mjs
jd-similarity.mjs
jd-skill-gap.mjs
match-star.mjs
negotiation-roi.mjs
outcome.mjs
process-quality.mjs
rejection-latency.mjs
role-matcher.mjs
salary-gap.mjs
skill-extract.mjs
stats.mjs
upskill.mjs
weekly-digest.mjs
```

## CV / application artifacts

```text
application-answers.mjs
application-artifacts.mjs
build-cv-html.mjs
build-cv-latex.mjs
cv-sections-core.mjs
cv-sync-check.mjs
cv-templates.mjs
extract-latex-content.mjs
generate-cover-letter.mjs
generate-latex.mjs
generate-pdf.mjs
img-to-pdf.mjs
mark-pdf-ready.mjs
openai-tailor.mjs
patch-latex-content.mjs
prepare-application.mjs
sync-pdf-flags.mjs
theme-style.mjs
verify-cv-facts.mjs
```

## Model/evaluation runners

```text
batch-evaluate-gemini.mjs
batch-tailor.mjs
gemini-eval.mjs
ollama-eval.mjs
openai-eval.mjs
openrouter-runner.mjs
```

## Contacts / replies / follow-ups

```text
contacts.mjs
followup-cadence.mjs
followup-seed.mjs
invite-match.mjs
linkedin-join.mjs
paste-reply.mjs
reply-matcher.mjs
reply-watch.mjs
```

## Core ops / setup / maintenance

```text
agent-inbox.mjs
doctor.mjs
intake.mjs
jsonc-parse.mjs
manifesto.mjs
path-resolver.mjs
profile-language.mjs
seed-fixture.mjs
title-keywords.mjs
update-system.mjs
validate-plugin-registry.mjs
validate-system-paths-coverage.mjs
validate-untrusted-content-coverage.mjs
plugin-audit.mjs
plugin-install.mjs
plugins.mjs
```

## Tests that intentionally remain special

Некоторые root `*-tests.mjs` upstream запускает специальным образом. Их **не переносим по имени папки просто ради красоты** без понимания `test-all.mjs`/workflow contract.

---

# Naming for new fork scripts

Используем понятные глаголы:

```text
scan-telegram.mjs
scan-hh.mjs
run-discovery.mjs
backfill-telegram.mjs
probe-source.mjs
```

Не называем новые файлы `utils2`, `helper-new`, `misc`.

Source-specific reusable code:

```text
scripts/integrations/telegram/client.mjs
scripts/integrations/telegram/normalize.mjs
scripts/integrations/hh/client.mjs
```

Common logic:

```text
scripts/lib/source-item.mjs
scripts/lib/source-summary.mjs
```

---

# Import boundaries

Желаемое направление зависимостей:

```text
integrations/* ---> common contract <--- providers/*
       |                 |
       v                 v
             discovery/*
                 |
                 v
          canonical writers
```

Позже:

```text
pipeline/decision ---> actions/*
```

Запрещённая связка:

```text
Telegram parser -> HH apply
```

Источник не должен напрямую вызывать executor другого источника.

---

# Если всё-таки физически переносим upstream root scripts

Это отдельная migration задача и делается только после baseline tests.

Порядок:

1. построить список root scripts и import graph;
2. найти все ссылки в `package.json`, `AGENTS.md`, modes, docs, workflows и tests;
3. выбрать конечные directories;
4. сначала добавить compatibility wrappers в старые root paths;
5. перенести implementation;
6. обновить `SYSTEM_PATHS`/updater coverage;
7. обновить docs/workflows/package scripts;
8. прогнать полный `node test-all.mjs` и updater migration tests;
9. только отдельным следующим этапом решать, удалять ли wrappers.

До этого момента flat root считаем upstream compatibility surface, а не местом для нашего нового кода.
