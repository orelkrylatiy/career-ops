# Roadmap форка: RU job discovery and career automation

Этот форк превращает upstream `career-ops` в управляющий слой нашего поиска работы в РФ и смежных рынках.

Главный приоритет на ближайший этап:

> **регулярно обходить карьерные сайты/ATS, HH.ru и заданные Telegram-каналы, приводить всё к общей pipeline, удалять дубли и оставлять только полезные вакансии.**

Автоматические отклики, recruiter outreach и заполнение ATS forms остаются следующими слоями, а не условием первого MVP.

Подробности:

- [`FORK_ARCHITECTURE_RU.md`](FORK_ARCHITECTURE_RU.md) — архитектура и решения;
- [`BACKLOG_RU.md`](BACKLOG_RU.md) — живой backlog;
- [`../scripts/README.md`](../scripts/README.md) — структура fork-owned code.

---

## 1. Что используем из upstream

`career-ops` уже даёт:

- AI workflows в `modes/*.md`;
- публичный scanner `scan.mjs`;
- `providers/*` для ATS/job sources;
- `data/pipeline.md` как inbox найденных вакансий;
- `data/applications.md` как canonical tracker;
- reports/JDs/CV/PDF generation;
- liveness, dedup, tracker и analytics tooling;
- plugin model для внешних integrations;
- files-first architecture: файлы — source of truth, SQLite — derived index.

Не переписываем это без доказанной необходимости.

Upstream flow:

```text
scan -> pipeline -> evaluate -> report/CV -> tracker -> human action
```

Наш ближайший flow:

```text
ATS/career sites + HH + Telegram
            |
            v
          ingest
            |
            v
     normalize / filter
            |
            v
           dedup
            |
            v
     data/pipeline.md
            |
            v
      optional ranking
```

---

## 2. Архитектурные границы

### Source

Получает новые items из внешней системы.

### Decision

Определяет:

- это вообще вакансия или шум;
- новая ли она;
- является ли она дублем;
- стоит ли её поднимать выше;
- нужен ли полноценный LLM evaluation.

### Action

Позже выполняет:

- apply;
- form fill;
- recruiter outreach;
- follow-up;
- reply/status sync.

**Source, Decision и Action не смешиваем.**

---

# Phase 0 — Foundation / baseline

Цель: понимать настоящий upstream runtime и не ломать его случайными рефакторами.

- [x] Изучить architecture/data contract/providers/plugin model.
- [x] Изучить donor implementations.
- [x] Создать architecture/strategy document.
- [x] Создать living backlog.
- [x] Создать структуру для нового fork-owned code под `scripts/`.
- [ ] Настроить локальный candidate profile без секретов в git.
- [ ] Прогнать upstream `node test-all.mjs` до behavior changes.
- [ ] Запустить один existing public provider scan.
- [ ] Провести одну вакансию через pipeline/evaluation/tracker.

### Root scripts

Upstream намеренно держит большую часть `.mjs` в корне из-за path compatibility и updater contract.

Поэтому сейчас:

```text
existing upstream root scripts -> остаются на месте
new fork scripts               -> scripts/<area>/
```

Если позже захотим physical migration — это отдельный эпик с compatibility wrappers и полным тестовым прогоном.

---

# Phase 1 — Common source/ingest contract

Цель: новые источники подключаются одинаково.

Концептуально нам нужен source item со следующими свойствами:

```text
source kind
stable source id
canonical source URL
raw/normalized vacancy data
published time
source metadata
optional contacts
```

Stable ids:

```text
HH        -> hh:<vacancy_id>
Telegram  -> telegram:<channel>:<message_id>
ATS       -> canonical posting URL/provider id
```

На первом этапе не ломаем upstream `Job` type: строим adapter boundary и расширяем формат только когда появится конкретная необходимость.

Acceptance:

```text
source -> normalized items -> canonical pipeline writer
```

с dry-run, per-source errors и summary counters.

---

# Phase 2 — Career sites / ATS coverage

Цель: подключить наши реальные целевые компании.

Для каждой компании:

```text
career URL
  -> определить ATS/vendor
  -> проверить existing provider
  -> добавить config
  -> только если provider отсутствует: найти public API/feed
  -> только потом писать новый adapter/browser fallback
```

Сначала используем уже существующие Greenhouse/Ashby/Lever/Workday/Teamtailor/etc providers.

Результат:

> добавляем компанию в config — её новые вакансии появляются в pipeline.

---

# Phase 3 — HH discovery

Цель: HH становится ещё одним source, а не отдельной системой вокруг которой построен весь fork.

Flow:

```text
HH API/search
 -> hh:<vacancy_id>
 -> normalize
 -> dedup
 -> pipeline
```

Требования:

- несколько поисковых запросов;
- pagination/caps;
- одна HH vacancy не появляется несколько раз;
- сохраняется canonical HH URL;
- ошибки HH изолированы от других sources;
- понятная статистика run.

Auto-apply сюда **не входит**.

---

# Phase 4 — Telegram ingest

Цель: заданные нами Telegram-каналы становятся полноценными vacancy sources.

MVP:

```text
Telethon session
 -> configured channels
 -> recent messages
 -> age filter
 -> vacancy/keyword gate
 -> anti-resume/spam filter
 -> channel:message_id dedup
 -> URL/contact extraction
 -> common pipeline
```

Сохраняем минимум:

```text
channel
message id
message URL
published time
raw text
extracted HH/ATS/career links
@username/email/phone when obvious
```

LLM classification не должен запускаться на каждом сообщении. Сначала дешёвые filters/dedup, semantic/LLM — только для неоднозначных кейсов.

---

# Phase 5 — Cross-source dedup and ranking

Цель: вакансия, найденная в нескольких местах, остаётся одной canonical vacancy.

Порядок signals:

1. exact source id;
2. canonical URL;
3. embedded HH/ATS URL из Telegram;
4. normalized company + title + date;
5. text fingerprint/SimHash при необходимости.

При merge сохраняем все source refs.

После dedup добавляем дешёвый pre-ranking, чтобы полноценный career-ops evaluation запускался только по полезной части pipeline.

---

# Phase 6 — Scheduler / operations

Цель: discovery реально работает регулярно.

Нужно:

- единый runner;
- dry-run;
- source isolation/timeouts;
- overlapping-run lock;
- cadence;
- health state;
- summary counters;
- useful logging.

Желаемый итог run:

```text
ATS       fetched/new/accepted/dup/errors
HH        fetched/new/accepted/dup/errors
Telegram  fetched/new/accepted/filtered/errors
```

---

# Milestone: Discovery v0

Первый настоящий product milestone:

```text
public ATS/career sites
+ HH
+ Telegram
      |
      v
 normalize
      |
      v
   dedup
      |
      v
 data/pipeline.md
```

Done, когда:

- повторный run не дублирует старые вакансии;
- source каждой вакансии известен;
- Telegram сообщения имеют stable id/URL;
- ошибка одного source не валит остальные;
- есть dry-run;
- есть run summary;
- очевидный мусор отбрасывается без LLM;
- новые компании/каналы добавляются конфигурацией или маленьким adapter, а не переписыванием всей системы.

---

# Phase 7 — HH action vertical slice

Только после Discovery v0.

```text
canonical vacancy
 -> evaluation/decision
 -> ActionRequest
 -> HH executor
 -> verify result
 -> tracker
```

Берём из `hh-autoresponder` и других donor implementations:

- sync already-applied state;
- idempotency;
- daily cap;
- retry budget;
- platform pause/global error handling;
- API-first;
- browser fallback only when needed;
- verify before marking success.

---

# Phase 8 — ATS/browser actions

После HH action slice.

Reference: JobApplyAgent.

Нужно:

- form inspection;
- dynamic DOM extraction;
- layered answer resolver;
- CV/cover upload;
- conditional multi-pass fill;
- answer cache;
- `needs_review` на неизвестных/опасных вопросах;
- explicit result verification.

---

# Phase 9 — Contacts / outreach / replies

Добавляем:

```text
Telegram recruiters
email
LinkedIn
HH messages
```

Нужны единый Contact model, cooldown/history и связь с canonical application.

Analytics:

```text
source
 -> discovered
 -> accepted
 -> evaluated
 -> applied
 -> reply
 -> interview
 -> offer
```

Оптимизируем качество воронки, а не число автоматических действий.

---

## Donor-проекты и что из них берём

### HHunter

- Telethon runner/session;
- staged Telegram filters;
- anti-resume;
- age filter;
- text-hash dedup;
- contact extraction;
- unified vacancy pipeline;
- dry-run.

### job_monitoring_tg

- простой MVP scanner;
- per-channel error isolation;
- `channel + message_id` state;
- canonical message URL;
- pause/resume/scheduler patterns.

### hh-autoresponder

- HH action/idempotency patterns;
- already-applied sync;
- caps/retries;
- platform-level failure handling;
- API-first + browser fallback.

### profi_ru_bot

- persistent browser profile;
- page-ready synchronization;
- JS-aware extraction;
- урок: aggressive polling и нестандартный embedded browser быстро создают проблемы.

### JobApplyAgent

- fork-owned `scripts/` organization;
- reusable form engine under `scripts/lib/`;
- diagnostics/probes;
- dynamic/conditional form filling;
- answer cache.

---

## Правила развития форка

1. Discovery first.
2. Source != Decision != Action.
3. API/feed/provider before browser automation.
4. Cheap filters before LLM.
5. Stable source IDs and idempotency from первого дня.
6. Ошибка одного source не должна ломать весь run.
7. Не создавать вторую canonical DB без доказанной причины.
8. Secrets/session strings/cookies/PII не коммитятся.
9. Новые fork scripts идут под `scripts/`, upstream compatibility surface без причины не двигаем.
10. Behavior changes идут с тестами.
11. Сначала один работающий vertical slice, потом расширение.
12. `FORK_ARCHITECTURE_RU.md` и `BACKLOG_RU.md` обновляются вместе с важными решениями.
