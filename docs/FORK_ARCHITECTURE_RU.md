# Архитектура и стратегия RU discovery fork

> Living document. Это основной файл для понимания, **зачем существует наш форк, как он устроен и в какую сторону мы его развиваем**. Если меняется архитектурное решение — сначала обновляем этот документ и `BACKLOG_RU.md`, затем код.

## 1. North Star

Базовая цель форка простая:

> **автоматически обходить заданные нами источники вакансий — карьерные сайты компаний, публичные ATS, HH.ru, Telegram-каналы и позже другие источники — приводить найденное к единому формату, отсеивать мусор и дубли, сохранять в одну pipeline и помогать быстро решить, куда стоит идти дальше.**

MVP не обязан автоматически отправлять отклики.

Первый полезный контур:

```text
configured sources
      |
      v
fetch / scan
      |
      v
normalize
      |
      v
cheap filters
      |
      v
deduplicate
      |
      v
data/pipeline.md
      |
      v
optional evaluate / rank
```

После того как discovery-контур стабилен, поверх него можно добавлять действия:

```text
apply / recruiter outreach / follow-up / reply sync
```

Но action automation не должна определять устройство discovery слоя.

---

## 2. Что такое career-ops в нашей системе

Upstream `career-ops` уже даёт большую часть управляющего слоя:

- `modes/*.md` — agent workflows: scan, evaluation, apply assistance, tracker, interview, follow-up и т.д.;
- `scan.mjs` + `providers/*` — обход публичных job sources;
- `data/pipeline.md` — inbox найденных вакансий;
- `data/applications.md` — canonical tracker;
- `reports/*` — результаты оценки вакансий;
- `jds/*` — сохранённые descriptions;
- CV/PDF generation;
- liveness, dedup, tracker tooling, analytics;
- plugin layer для интеграций с ключами/авторизацией;
- files-first data model: файлы остаются источником истины, SQLite — производный индекс.

Важно: AI harness находится снаружи. Codex / Claude Code / OpenCode читает инструкции `AGENTS.md` и `modes/*.md`, а Node-скрипты выполняют детерминированную часть работы.

### Базовый upstream flow

```text
scan
  -> data/pipeline.md
  -> evaluate
  -> report / tailored CV
  -> data/applications.md
  -> human action
```

### Наш flow

```text
sources
  -> ingest
  -> canonical SourceItem
  -> normalize + dedup
  -> pipeline
  -> evaluate/rank when useful
  -> later: action router
```

---

## 3. Главный архитектурный принцип: Source != Decision != Action

Не смешиваем три разных задачи.

### Source layer

Отвечает только за вопрос:

> Что нового появилось в источнике?

Примеры:

- Greenhouse/Ashby/Lever/Workday provider;
- HH API;
- Telegram channel through Telethon;
- RSS/JSON feed;
- карьерный сайт компании;
- browser-only page.

### Decision layer

Отвечает:

> Это вакансия? Она новая? Она нам подходит? Насколько она приоритетна?

Здесь живут:

- cheap keyword/negative filters;
- vacancy-vs-resume/spam classification;
- normalization;
- cross-source dedup;
- score/ranking;
- LLM evaluation, только когда дешёвых правил недостаточно.

### Action layer

Отвечает:

> Что с этой вакансией сделать?

Позже:

- подготовить CV/cover letter;
- откликнуться через HH;
- заполнить ATS form;
- написать рекрутеру;
- сделать follow-up;
- синхронизировать ответ/статус.

Одна и та же вакансия может быть найдена в Telegram, HH и на карьерном сайте. В pipeline она должна стать **одной вакансией с несколькими source refs**, а не тремя разными объектами.

---

## 4. Целевая схема

```text
                         config / portals
                              |
        +---------------------+----------------------+
        |                     |                      |
        v                     v                      v
 public ATS providers      HH source          Telegram source
 Greenhouse/...            API first             Telethon
        |                     |                      |
        +---------------------+----------------------+
                              |
                              v
                         raw SourceItem
                              |
                 +------------+-------------+
                 |                          |
                 v                          v
             cheap gates              metadata extract
       vacancy / keywords / age       contacts / URLs / ids
                 |                          |
                 +------------+-------------+
                              |
                              v
                         normalize
                              |
                              v
                 canonical dedup / merge
                              |
                              v
                       data/pipeline.md
                              |
                    +---------+---------+
                    |                   |
                    v                   v
                rank/eval          source analytics
                    |
                    v
             data/applications.md
                    |
                    v
             later action layer
```

---

## 5. Минимальный source contract

Новый источник не должен сам решать, стоит ли откликаться. Он возвращает нормализуемый item и source metadata.

Концептуально:

```ts
type SourceKind =
  | 'ats'
  | 'career-site'
  | 'hh'
  | 'telegram'
  | 'feed'
  | 'browser';

type SourceItem = {
  source: SourceKind;
  sourceId: string;
  sourceUrl: string;

  title?: string;
  company?: string;
  location?: string;
  description?: string;
  publishedAt?: string;

  contacts?: Array<{
    type?: 'telegram' | 'email' | 'phone';
    value: string;
  }>;

  metadata?: Record<string, unknown>;
};
```

Это пока **контракт направления**, а не обещание прямо сейчас менять upstream `Job` type. На первом этапе лучше адаптироваться к существующему provider/pipeline contract и добавлять sidecar metadata только там, где это действительно нужно.

### Stable source IDs

Нужны стабильные идентификаторы для идемпотентности:

```text
HH:        hh:<vacancy_id>
Telegram:  telegram:<channel>:<message_id>
ATS:       canonical posting URL / provider id
Feed:      source-specific id or canonical URL
```

---

## 6. Стратегия получения данных

Всегда выбираем самый дешёвый и устойчивый способ.

1. **Public structured API / feed / existing provider** — лучший вариант.
2. **Authenticated API / integration** — если источник требует сессию или token.
3. **Telethon** — для чтения Telegram-каналов от имени пользовательской сессии.
4. **Server-rendered HTML** — если данные доступны стабильно без браузера.
5. **Playwright / real browser** — fallback для динамических или закрытых страниц.

Не начинаем с browser automation, если ту же информацию можно получить API-запросом.

---

## 7. Telegram: как строим ingest

Telegram — не отдельная CRM и не отдельная pipeline. Это ещё один источник вакансий.

MVP:

```text
configured channels
  -> Telethon
  -> recent messages
  -> stable id channel:message_id
  -> cheap vacancy gate
  -> age filter
  -> dedup
  -> extract URLs / @usernames / email / phone when present
  -> pipeline
```

### Почему staged filtering

До LLM должны отработать дешёвые проверки:

- пустой пост;
- слишком старый пост;
- negative keywords;
- очевидное резюме кандидата (`ищу работу`, `open to work`, `#резюме`);
- нет ни одного признака вакансии;
- уже видели `channel + message_id`;
- уже видели тот же текст/URL из другого источника.

Только после этого, если всё ещё неясно, можно делать более дорогой semantic/LLM classification.

### Что сохраняем из TG

По возможности:

- channel;
- message id;
- message URL;
- published time;
- raw text;
- role/title;
- company;
- stack/grade;
- salary;
- location/remote;
- HH/ATS/career URL;
- recruiter `@username`;
- email/phone/contact name.

Raw source metadata не должна теряться даже после нормализации.

---

## 8. HH: как используем

Для discovery HH — источник вакансий, а не центр архитектуры.

Приоритет:

```text
HH API -> normalize -> pipeline
```

Если позже включаем action layer:

```text
career-ops decision
  -> HH executor
  -> verify result
  -> tracker
```

Из donor implementations полезны следующие правила:

- перед действием синхронизировать уже существующие отклики;
- не повторять apply на одну vacancy id;
- platform-level auth/quota error должен остановить дальнейшие попытки по платформе, а не создать десятки одинаковых failures;
- дневные лимиты и retries принадлежат executor layer;
- API first, browser fallback only when needed;
- действие считается успешным только после подтверждаемого результата.

---

## 9. Career sites / ATS

Upstream уже умеет обходить много публичных ATS через `providers/*`. Это используем прежде чем писать собственный browser scraper.

Для каждой новой компании сначала определяем:

```text
1. На каком ATS/движке карьерный сайт?
2. Уже есть provider?
3. Есть публичный JSON/API endpoint?
4. Нужен отдельный provider?
5. Только если нет — нужен browser adapter?
```

`portals.yml` должен постепенно стать декларативным списком компаний/бордов, которые нам интересны.

Цель: добавление очередного карьерного сайта — преимущественно **config/provider work**, а не написание нового монолитного робота.

---

## 10. Что берём из изученных donor-проектов

### HHunter (`Ixollozi/HHunter`)

Берём идеи:

- отдельный Telegram runner;
- Telethon StringSession / постоянная пользовательская сессия;
- разделение `tg_parser`, `tg_filter`, pipeline;
- дешёвые hashtag/keyword/vacancy gates до LLM;
- anti-resume filter;
- age filtering;
- text-hash dedup;
- extraction phone / Telegram usernames;
- `dry_run` для pipeline;
- один unified vacancy flow для разных источников.

Не тащим сейчас:

- FastAPI + React + Mini App как обязательную инфраструктуру;
- отдельную primary DB;
- Groq как обязательный classifier.

### `job_monitoring_tg`

Берём как хороший минимальный референс:

- маленький Telethon scanner;
- per-channel isolation: ошибка одного канала не ломает весь run;
- `channel + message_id` как stable external id;
- `is_seen / mark_seen`;
- canonical `t.me/<channel>/<message_id>` URL;
- scheduler cadence и pause/resume как простые ops-функции.

### `hh-autoresponder`

Берём в будущий action layer:

- pre-sync уже существующих HH откликов;
- idempotency;
- platform pause;
- daily caps;
- retry budget;
- не ретраить одинаковую глобальную ошибку для всей пачки;
- API-first + Playwright fallback;
- result logging.

Не делаем auto-apply частью discovery MVP.

### `profi_ru_bot`

Берём инженерные уроки, а не код:

- persistent browser profile/session;
- ждать реальную готовность динамической страницы;
- DOM/JS extraction лучше парсинга пустого HTML shell;
- aggressive reload polling быстро приводит к ограничениям;
- embedded/non-standard Chromium может вести себя иначе, чем обычный browser.

Не берём QWebEngine/PySide как базу нашей системы.

### JobApplyAgent (`shankswhite/JobApplyAgent`)

Берём позже для ATS actions:

- `scripts/lib/` для reusable form logic;
- dynamic DOM scan;
- layered answer resolver;
- multi-pass fill после появления conditional fields;
- local answer cache;
- отдельные `probe`/`scan` diagnostics;
- integration-specific code под `scripts/integrations/`.

До появления стабильного discovery это не текущий milestone.

---

## 11. Структура fork-owned scripts

Upstream намеренно держит большинство своих `.mjs` в корне. Эти пути используются updater'ом, тестами, документацией и сторонними integrations. Поэтому **мы не делаем массовый physical move upstream scripts одним коммитом**.

Для всего нового кода форка используем:

```text
scripts/
  discovery/       # source orchestration, ingest, scan helpers
  integrations/    # HH / Telegram / external integrations
  actions/         # apply/outreach executors; позже
  ops/             # scheduler, backfill, diagnostics, maintenance
  lib/             # fork-owned shared code
```

Подробные правила — `scripts/README.md`.

Если позже сознательно захотим переместить upstream root scripts, это отдельный migration epic: dependency graph, compatibility wrappers, updater paths, workflows, docs и полный test suite.

---

## 12. State и idempotency

Каждый source run должен быть безопасен для повторного запуска.

Минимальные правила:

- повторный scan не создаёт дубликат той же source item;
- один плохой source не ломает остальные;
- partial failure виден в логах;
- source state можно пересоздать или проверить;
- canonical files остаются source of truth;
- derived cache/index можно удалить и построить заново.

Для Telegram source state достаточно начать с `channel + message_id` и/или append-only seen state. Для cross-source dedup используем canonical URL + нормализованный company/title + text fingerprint по необходимости.

---

## 13. Observability

Нам важнее понимать воронку источников, чем просто количество HTTP requests.

На каждый run полезно видеть:

```text
source
fetched
new
skipped_old
skipped_not_vacancy
skipped_duplicate
accepted_to_pipeline
errors
```

Позже:

```text
accepted -> evaluated -> applied -> reply -> interview -> offer
```

Это позволит понять, какие карьерные сайты/каналы реально дают результат.

---

## 14. Первый milestone: Discovery v0

Считаем milestone выполненным, когда одна команда/runner умеет:

```text
existing ATS providers
+ HH discovery
+ configured Telegram channels
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

Acceptance criteria:

- повторный запуск не создаёт те же записи;
- виден source каждой вакансии;
- Telegram message сохраняет canonical message URL/id;
- ошибка одного канала/компании не валит весь scan;
- можно запустить dry-run;
- source counts/errors видны в summary;
- LLM не нужен для очевидных кейсов;
- auto-apply отсутствует в critical path.

---

## 15. Следующая стадия после Discovery v0

После стабильного discovery:

```text
pipeline
 -> rank
 -> evaluate only top candidates
 -> prepare materials
 -> optional action adapter
 -> result verification
 -> tracker
```

Первым action adapter логично делать HH, потому что там можно проверить idempotency и результат на хорошо определённой vacancy id. ATS/browser actions и recruiter outreach идут после него.

---

## 16. Как поддерживаем эту документацию

- `FORK_ARCHITECTURE_RU.md` — **почему и как устроена система**.
- `BACKLOG_RU.md` — **что делаем сейчас/дальше**.
- `FORK_ROADMAP_RU.md` — **крупные этапы**.
- `scripts/README.md` — **куда класть код и почему**.

Не превращаем эти файлы в дневник каждого коммита. Фиксируем только решения, которые помогут через месяц быстро восстановить контекст проекта.
