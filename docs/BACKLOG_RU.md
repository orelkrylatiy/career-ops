# Backlog RU fork

> Living backlog для нашего форка `career-ops`. Этот файл отвечает на вопрос: **что мы делаем сейчас, что следующим, и зачем**.

Связанные документы:

- [`FORK_ARCHITECTURE_RU.md`](FORK_ARCHITECTURE_RU.md) — архитектура и стратегия;
- [`FORK_ROADMAP_RU.md`](FORK_ROADMAP_RU.md) — крупные этапы;
- [`../scripts/README.md`](../scripts/README.md) — структура нового кода.

## Как ведём backlog

Статусы:

```text
[NOW]      делаем в текущем цикле
[NEXT]     следующий приоритет
[LATER]    полезно, но не сейчас
[BLOCKED]  ждёт решения/зависимости
[DONE]     закончено и проверено
```

Правило приоритета:

> Сначала делаем самый короткий end-to-end путь, который даёт реальные новые вакансии в `data/pipeline.md`. Только потом расширяем каналы и автоматизируем действия.

Definition of Done для behavior-changing задачи:

- есть понятный вход/выход;
- повторный запуск безопасен;
- ошибки одного source не валят весь run;
- есть dry-run там, где операция пишет state или делает внешнее действие;
- ключевой happy path покрыт тестом;
- документация обновлена, если изменилась архитектура/контракт;
- secrets/cookies/session strings не попадают в git.

---

# Current cycle — Foundation + Discovery v0

## E0. Понять и привести форк в рабочий вид

- [DONE] Создать отдельную fork branch `feat/russia-automation-foundation`.
- [DONE] Зафиксировать первичный roadmap.
- [DONE] Изучить upstream architecture, data contract, providers и plugin model.
- [DONE] Повторно изучить donor-проекты: HHunter, job_monitoring_tg, hh-autoresponder, profi_ru_bot, JobApplyAgent.
- [DONE] Создать living architecture document с нашим контекстом.
- [DONE] Создать living backlog.
- [NOW] Ввести понятную структуру для всего нового fork-owned кода под `scripts/`.
- [NEXT] Локально прогнать upstream setup + `node test-all.mjs` до behavior changes.
- [NEXT] Проверить одну существующую public ATS scan цепочку end-to-end.
- [NEXT] Зафиксировать baseline output: pipeline, tracker, report, generated CV.

### Отдельный вопрос: root scripts

Upstream специально держит большое количество `.mjs` в корне из-за стабильности путей, updater contract, тестов, docs и community scripts.

Поэтому:

- [DONE] Не делать опасный bulk-move upstream root scripts вслепую.
- [NOW] Все **новые наши** scripts класть в тематические директории.
- [LATER] Если реально мешает flat root — провести отдельную migration spike: dependency graph → compatibility wrappers → updater paths → docs/workflows → full tests.

---

# E1. Source abstraction / ingest contract

Цель: любой новый источник подключается одинаково и не знает ничего про apply logic.

- [NOW] Определить минимальную форму `SourceItem` и правила stable source id.
- [NOW] Не ломать существующий upstream `Job` contract без необходимости: сначала adapter поверх него.
- [NEXT] Определить общую source metadata envelope: source type, source id, canonical URL, published time, raw source ref.
- [NEXT] Определить, где metadata живёт до момента, когда upstream tracker schema действительно нужно расширять.
- [NEXT] Добавить единый dry-run source summary.
- [NEXT] Добавить source-level counters: fetched/new/skipped/accepted/errors.
- [NEXT] Проверить isolation: один упавший source не отменяет результаты остальных.

Acceptance:

```text
source adapter -> normalized items -> canonical writer
```

без знания о CV/apply/recruiter outreach.

---

# E2. Career sites / public ATS

Цель: максимально использовать уже готовый upstream discovery.

- [NEXT] Составить наш список целевых компаний РФ/финтех/IT и их career URLs.
- [NEXT] Для каждой определить ATS/vendor: Greenhouse/Ashby/Lever/Workday/Teamtailor/custom/etc.
- [NEXT] Проверить, какие уже покрываются `providers/*`.
- [NEXT] Добавить их в наш `portals.yml`/fork config без написания нового кода там, где provider уже есть.
- [NEXT] Для custom career sites искать structured JSON/API endpoint до browser automation.
- [LATER] Добавлять новые public providers только для реально отсутствующих источников.
- [LATER] Browser-only adapter для сайтов, где API/feed невозможно получить устойчиво.

Definition of useful result:

> Добавить новую компанию в config и увидеть её новые вакансии в pipeline без ручного браузинга.

---

# E3. HH.ru discovery

Цель: HH участвует в discovery как один из источников.

- [NEXT] Проверить официальный HH API flow и ограничения для нашего use case.
- [NEXT] Сделать HH source adapter, который только получает вакансии и нормализует их.
- [NEXT] Stable id: `hh:<vacancy_id>`.
- [NEXT] Сохранять canonical vacancy URL.
- [NEXT] Поддержать несколько search queries без дублирования одной vacancy.
- [NEXT] Добавить source pagination/caps и понятный run summary.
- [NEXT] Дедуп с той же вакансией, найденной через Telegram/карьерный сайт, когда есть совпадающий URL/source reference.
- [LATER] Authenticated HH features.
- [LATER] HH apply executor — отдельный epic после Discovery v0.

Donor patterns to reuse conceptually:

- `hh-autoresponder`: API-first, pre-sync state, idempotency, platform pause/errors;
- HHunter: HH import в unified vacancy flow.

---

# E4. Telegram ingest

Цель: список Telegram-каналов становится таким же конфигурируемым source list, как карьерные сайты.

## MVP

- [NEXT] Выбрать формат конфигурации Telegram channels.
- [NEXT] Подключить Telethon user session; session secret не коммитить.
- [NEXT] Читать последние сообщения по каждому configured channel.
- [NEXT] Stable id: `telegram:<channel>:<message_id>`.
- [NEXT] Canonical URL: `https://t.me/<channel>/<message_id>` для публичных каналов.
- [NEXT] Ошибка одного канала не ломает остальные.
- [NEXT] Age filter.
- [NEXT] Cheap keyword/vacancy gate.
- [NEXT] Anti-resume filter (`ищу работу`, `open to work`, `#резюме`, etc.).
- [NEXT] Seen/dedup state.
- [NEXT] Сохранять raw text + source metadata.
- [NEXT] Extract obvious `@username`, email, phone, HH/ATS URL.
- [NEXT] Записывать прошедшие сообщения в common pipeline.

## После MVP

- [LATER] Text fingerprint dedup для reposts/cross-posts.
- [LATER] LLM classification только для неоднозначных сообщений.
- [LATER] Semantic extraction role/company/grade/salary/stack.
- [LATER] Channel quality metrics.
- [LATER] Backfill с ограничением по давности.
- [LATER] Отдельный recruiter/contact enrichment flow.

Donor strategy:

- `job_monitoring_tg` — минимальная scanner-модель;
- HHunter — staged filter pipeline, age/anti-resume/hash/contact extraction.

---

# E5. Normalize + dedup

Цель: одна реальная вакансия не размножается из-за разных источников.

- [NEXT] Первый уровень: exact source id.
- [NEXT] Второй уровень: canonical URL.
- [NEXT] Нормализовать known tracking/query params в URLs.
- [NEXT] Если TG post содержит HH/ATS URL — связать source ref с canonical posting.
- [LATER] Company + normalized title + posting time heuristic.
- [LATER] Text fingerprint / SimHash для cross-posting без URL.
- [LATER] Merge source refs вместо удаления полезной source metadata.

Правило:

> Dedup не должен уничтожать доказательство того, где мы нашли вакансию.

---

# E6. Runner / scheduling / observability

Цель: discovery можно запускать регулярно и понимать, что произошло.

- [NEXT] Один CLI entrypoint для нашего discovery run.
- [NEXT] `--dry-run`.
- [NEXT] Source-level timeout/isolation.
- [NEXT] Summary counters.
- [NEXT] Exit codes, пригодные для cron/automation.
- [LATER] Lock, чтобы два overlapping run не писали pipeline одновременно.
- [LATER] Configurable cadence per source type.
- [LATER] Health state источников.
- [LATER] Notifications только на meaningful events/errors.

Пример желаемого summary:

```text
ATS        fetched 84   new 9   accepted 7   dup 2   errors 0
HH         fetched 120  new 14  accepted 8   dup 6   errors 0
Telegram   fetched 76   new 11  accepted 4   filtered 7 errors 1
```

---

# E7. Rank / evaluate economically

Цель: не тратить LLM evaluation на весь шум.

- [LATER] Cheap pre-ranking по title/stack/location/salary/source quality.
- [LATER] Прогонять полноценный career-ops evaluation только по shortlist.
- [LATER] Проверить, как лучше использовать существующий `rank-pipeline.mjs`.
- [LATER] Порог score должен быть конфигурируемым, а не зашитым в source adapter.
- [LATER] Собирать причины skip/rank для последующей настройки правил.

---

# E8. Application/action automation — после Discovery v0

Это отдельный слой, не current MVP.

## HH action adapter

- [LATER] ActionRequest/ActionResult contract.
- [LATER] Sync already-applied ids before apply batch.
- [LATER] Idempotency by HH vacancy id.
- [LATER] Daily limits/retry budget/platform pause.
- [LATER] API first.
- [LATER] Browser fallback только для реально необходимых форм/tests.
- [LATER] Verify result before tracker status changes.

## ATS form actions

- [LATER] Изучить перенос reusable частей JobApplyAgent `scripts/lib/`.
- [LATER] Dynamic DOM field extraction.
- [LATER] Layered answer resolver.
- [LATER] Conditional multi-pass fill.
- [LATER] Answer learning cache.
- [LATER] Unknown questions -> `needs_review`.

## Recruiter outreach

- [LATER] Contact model.
- [LATER] Telegram/email/LinkedIn channels.
- [LATER] Per-contact cooldown.
- [LATER] Message history and application linkage.
- [LATER] Human review policy before automatic sending decisions.

---

# E9. Replies + funnel analytics

- [LATER] HH replies/status sync.
- [LATER] Email replies.
- [LATER] Telegram recruiter replies.
- [LATER] Join response to canonical application.
- [LATER] Source-to-interview conversion.
- [LATER] Source-to-offer conversion.
- [LATER] Channel/company quality reports.

North-star analytics:

```text
source -> discovered -> accepted -> evaluated -> applied -> reply -> interview -> offer
```

Оптимизируем не `applications/day`, а вероятность получить хороший процесс и оффер.

---

# Research / donor notes

## HHunter

Полезно:

- Telethon runner/session lifecycle;
- cheap gates before Groq;
- anti-resume;
- age filter;
- text hash;
- phone/username extraction;
- unified vacancy flow;
- dry-run.

Не тащим целиком:

- FastAPI/React/Mini App infrastructure;
- primary DB architecture;
- обязательную LLM-зависимость.

## job_monitoring_tg

Полезно:

- очень маленький Telegram scanner;
- per-channel exceptions;
- `channel + message id` dedup;
- simple pause/resume/status;
- persistent Telethon session.

## hh-autoresponder

Полезно позже:

- HH idempotency;
- sync already-applied;
- caps/retries;
- abort whole platform on global auth/quota error;
- API-first with browser fallback.

## profi_ru_bot

Полезные уроки:

- dynamic pages требуют JS/browser-aware extraction;
- ждать page-ready event;
- persistent session/profile;
- aggressive polling leads to bans/rate limits;
- embedded browser может быть хуже обычного Chromium/Playwright.

## JobApplyAgent

Полезно позже:

- fork-specific `scripts/` organization;
- `scripts/lib` reusable form engine;
- probe tools;
- conditional multi-pass fill;
- answer cache.

---

# Parking lot / открытые решения

- [BLOCKED] Нужен ли отдельный fork-specific source config или расширяем `portals.yml` для HH/TG?
- [BLOCKED] Как хранить несколько `source refs` без преждевременной ломки tracker schema?
- [BLOCKED] Какой формат persistent seen-state выбрать для Telegram, если canonical pipeline уже files-first?
- [BLOCKED] Нужно ли запускать Telegram ingest из Node напрямую или отдельным Python/Telethon process с простым boundary?
- [BLOCKED] Когда наш fork достаточно расходится с upstream, чтобы physical move root scripts стал выгоднее совместимости?

Эти решения закрываем только когда упираемся в них в первом vertical slice, а не заранее.
