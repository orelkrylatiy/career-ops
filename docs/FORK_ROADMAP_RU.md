# Roadmap форка: RU job-search automation

Этот форк используется как управляющий слой поиска работы: discovery, нормализация, оценка вакансий, персонализация материалов, единый tracker и оркестрация действий во внешних каналах.

Цель — сохранить сильные части upstream `career-ops` и постепенно добавить российские источники и action-adapters, не превращая HH.ru в центр всей архитектуры.

## 1. Что уже есть в upstream

`career-ops` состоит из нескольких слоёв:

1. **AI harness снаружи** — Codex / Claude Code / OpenCode / другой CLI исполняет инструкции.
2. **Skill/router** — `.agents/skills/career-ops/SKILL.md` выбирает workflow.
3. **Agent workflows** — `modes/*.md`: evaluation, scan, apply, tracker, interview, follow-up и т.д.
4. **Deterministic scripts** — `*.mjs`: scan, dedup, tracker, PDF, liveness, analytics, ATS discovery и другие операции.
5. **Providers** — `providers/*.mjs` приводят публичные job sources к общей форме вакансии.
6. **Persistent user data** — `cv.md`, `config/profile.yml`, `data/applications.md`, `data/pipeline.md`, `reports/`, `jds/`.
7. **Derived index** — SQLite используется только как ускоряющий индекс; каноническое состояние хранится в файлах.
8. **Plugins** — отдельный слой для интеграций, которые не должны входить в public/no-auth core.

Базовый flow upstream:

```text
scan -> data/pipeline.md -> evaluate -> report/CV -> data/applications.md -> human apply
```

Наш целевой flow:

```text
sources -> normalize/dedup -> evaluate -> decision -> action adapter -> result -> tracker
```

## 2. Граница ответственности

### `career-ops`

Отвечает за:

- единый candidate profile;
- canonical vacancy / pipeline;
- дедупликацию между источниками;
- fit scoring;
- company/job research;
- tailored CV / cover message / form answers;
- contacts и outreach context;
- единый application tracker;
- follow-up и outcome analytics;
- решение, какое действие нужно выполнить дальше.

### `work-optimization`

Остаётся HH-specific executor/service:

- HH API;
- поиск/получение HH-вакансий;
- отклики;
- ответы работодателям;
- HH-specific retries, rate limits, idempotency;
- профили и HH-specific state.

`career-ops` не должен дублировать эту логику. Интеграция строится через adapter/contract.

### Другие adapters

Позже:

- Telegram: Telethon ingest + recruiter outreach;
- ATS/career sites: Greenhouse/Ashby/Lever/Workday browser/form adapter;
- email: application/outreach + reply ingestion;
- LinkedIn: discovery/outreach/apply adapter;
- browser fallback: только для web-only возможностей и диагностики.

## 3. Архитектурная ставка

```text
                    Codex / Claude
                         |
                  career-ops skill
                         |
       +-----------------+-----------------+
       |                 |                 |
   discovery          decision           tracker
       |                 |                 |
 HH / TG / ATS  -> normalize+dedup -> applications
       |                 |
       +--------> scoring/research
                         |
                    action router
       +-----------------+-----------------+
       |                 |                 |
 work-optimization   telegram adapter   ATS/email/etc
       |                 |                 |
      HH              Telegram          external systems
       +-----------------+-----------------+
                         |
                    result/events
                         |
                      tracker
```

Ключевое правило: **source, decision и action — разные слои**. Одна и та же вакансия может быть найдена в Telegram, HH и на сайте компании, но в tracker должна существовать как одна canonical vacancy/application.

## 4. Что не переписываем сразу

На первом этапе не трогаем без необходимости:

- upstream scoring (`modes/_shared.md`, `modes/oferta.md`);
- tracker format и status machinery;
- PDF/CV generation;
- public ATS providers;
- liveness/dedup scripts;
- updater;
- dashboard.

Сначала используем их как готовую платформу и меняем только места, необходимые для RU automation.

## 5. Этапы доработки

### Phase 0 — понять и запустить upstream

- [ ] Настроить локальный candidate profile без секретов в git.
- [ ] Запустить одну ручную вакансию через auto-pipeline.
- [ ] Запустить `scan` на существующих public providers.
- [ ] Проверить tracker, report и generated CV.
- [ ] Прогнать тесты upstream до наших изменений.

Результат: понимаем реальный runtime, а не только README.

### Phase 1 — единый integration contract

Сделать минимальную модель взаимодействия с внешними executors.

Нужны сущности:

```text
Vacancy
Application
Contact
ActionRequest
ActionResult
SourceRef
```

Минимальный action contract:

```text
prepare -> execute -> verify -> persist result
```

Поля результата должны позволять отличить:

```text
applied / skipped / duplicate / needs_review / failed / rate_limited
```

На этом этапе action может быть dry-run.

### Phase 2 — HH vertical slice

Первый настоящий end-to-end канал:

```text
HH vacancy
-> canonical vacancy
-> career-ops evaluation
-> decision threshold
-> work-optimization adapter
-> HH apply
-> verified result
-> career-ops tracker
```

Требования:

- не откликаться повторно;
- сохранять HH vacancy id + URL как source refs;
- хранить причину skip/failure;
- rate limit остаётся внутри HH executor;
- сначала dry-run и маленькая тестовая пачка;
- затем configurable auto-submit policy.

### Phase 3 — Telegram ingest

Reference/donor: HHunter/JSS.

```text
Telethon
-> channel messages
-> cheap filters
-> vacancy extraction
-> recruiter/contact extraction
-> canonical vacancy
-> dedup against HH/ATS
-> evaluation
```

Из сообщений извлекаем по возможности:

- company;
- role;
- stack;
- grade;
- salary;
- location/remote;
- HH/ATS/career URL;
- email;
- Telegram username;
- phone/contact name.

Отдельно различаем channel / recruiter / bot username.

### Phase 4 — contact enrichment + outreach

Единый `Contact` слой:

```text
recruiter | hiring-manager | peer | interviewer
```

Каналы:

```text
Telegram / email / LinkedIn
```

Нужны recruiter-level cooldown, история сообщений и связь контакта с application/tracker id.

### Phase 5 — career sites / ATS actions

Использовать существующий public ATS discovery из career-ops для поиска.

Для apply:

- form inspection;
- answer cache;
- CV upload;
- conditional fields;
- submit verification;
- `needs_review` при неизвестном вопросе/captcha/неоднозначном результате.

Reference: JobApplyAgent.

### Phase 6 — replies и analytics

Объединить ответы из:

- HH;
- email;
- Telegram;
- LinkedIn.

Метрики:

```text
source -> discovered -> evaluated -> applied -> reply -> screen -> tech -> offer
```

Оптимизируем не число отправок, а conversion в интервью/офферы.

## 6. Правила реализации форка

1. Сначала vertical slice, потом новые каналы.
2. Не создавать вторую canonical DB: следуем upstream-принципу files-first, пока нет доказанной причины менять его.
3. SQLite/индексы — derived state.
4. Любое внешнее действие должно быть идемпотентным либо иметь проверку перед повтором.
5. Action result проверяется после выполнения; факт вызова API/клика сам по себе не равен success.
6. Secrets, session strings, cookies, API keys и PII не коммитятся.
7. Новые источники не смешиваются с action logic.
8. Browser automation — adapter/fallback, а не единственная архитектурная основа.
9. Сохраняем возможность подтягивать upstream: минимизируем правки существующего core без необходимости.
10. Новые behavior-changing изменения идут с тестами.

## 7. Первый технический milestone

Не строим сразу Telegram + HH + LinkedIn + email.

Первый milestone:

```text
one vacancy
-> evaluate
-> ActionRequest
-> HH adapter (dry-run)
-> ActionResult
-> tracker update
```

После него подключаем реальное выполнение через `work-optimization`.

## 8. Вопросы, которые надо решить до кода integration layer

- Как `work-optimization` будет вызываться: HTTP API, CLI/subprocess или queue?
- Какой минимальный canonical vacancy id использовать между источниками?
- Где хранить source refs (`hh_id`, Telegram message id, ATS URL)?
- Встраивать action adapters в plugin layer career-ops или сделать fork-specific integration layer?
- Где заканчивается decision policy и начинается executor policy?
- Как отражать `needs_review`, captcha и unknown form questions в существующих statuses?
- Какие поля tracker стоит расширять, а какие хранить в sidecar/event log, чтобы не ломать upstream format?

До ответа на эти вопросы не меняем tracker schema и core scoring.
