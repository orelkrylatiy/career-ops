# GLOSSARY — Career Ops Browser Autopilot

> Обновлено 2026-10-27. Этот форк целенаправленно **автономный** и работает с карьерными сайтами и агрегаторами через браузер. HeadHunter / hh-ops — отдельный продукт, **не источник и не канал отклика Career Ops**. Эти границы действуют для CLI, моделей и документации.

## Один результат

Пользователь запускает `npm run autopilot` (или `npm run autopilot:start`). Один runner инициирует сканирование российских источников, заполняет SQLite-очередь, запускает coding-agent для каждой вакансии с Playwright CLI, проверяет реальную отправку и сохраняет итог. Отклики отправляются в этом режиме без утверждения каждой формы. Нельзя придумывать данные кандидата, обходить CAPTCHA, SMS/2FA или считать клик доказательством отправки.

## Исполняемые части

- **Autopilot runner / Orchestrator** — `autopilot-runner.mjs`: единая команда, discovery → queue → claim → browser worker → verify/report → next. Управляет ошибками, таймаутами, запуском coding CLI и итоговым отчётом. **Это программа, а не описание режима.**
- **Agent / Coding CLI** — Claude Code, Codex или OpenCode, запускаемый runner в неинтерактивном режиме. Интерпретирует JD и формы, выбирает действия в браузере. Инструмент должен быть установлен и заранее авторизован.
- **Worker** — одна итерация coding-agent над одной арендованной вакансией. При сбое runner продолжает со следующей; безопасный повтор возможен только при доказанном отсутствии Submit.
- **Playwright CLI** — основной интерфейс агента к Chromium. Сессия `career-ops-worker-0` и профиль `data/browser-profile/` сохраняют авторизацию между вакансиями. Playwright-cli не равен Playwright MCP и не является сканером API.
- **Preflight** — `node autopilot.mjs preflight`: проверка контактов, существующего PDF и установленного Playwright CLI. **Не доказывает**, что открылась страница или что ATS принимает отклик; полноценное E2E нужно запускать отдельно.
- **Source Registry** — `source-registry.mjs`, каталог `catalog/source-catalog.yml` и runtime SQLite `data/source-registry.db`. Из компаний разрешает карьерные URL и ATS; не каждая каталогизированная площадка имеет provider.
- **Discovery / Scan** — дешёвый сбор вакансий через API/RSS/HTML; `scan-regional.mjs --country RU` сканирует российские источники. `--refresh-registry` обновляет каталог компаний (дольше). Это **не отправка откликов**.
- **Provider** — код адаптера ATS/агрегатора в `providers/*.mjs` (например, Habr Career, GeekJob, SuperJob, Greenhouse). Объявление источника с `access: browser` без `provider` само по себе не создаёт сканер.
- **Browser discovery** — поиск официального карьерного URL и интерактивных вакансий для источников без поддерживаемого API; всё ещё отдельная нерешённая задача для расширения покрытия.

## Данные и состояния

- **User layer** — `cv.md`, `config/profile.yml`, `portals.yml`, `data/*`, `output/*`, `reports/*`, `modes/_custom.md`, `voice-dna.md`: приватные файлы, не публикуемые в Git. **System layer** — исполняемые скрипты, шаблоны, обычные modes и правила.
- **Pipeline / Inbox** — `data/pipeline.md`, обнаруженные URL до постановки в автономную очередь.
- **Autopilot SQLite** — `data/autopilot.db`: **источник истины для очереди, leases, outcomes и attempts**; отличен от файлового пользовательского трекера. `data/autopilot-queue.md` — производный человекочитаемый снимок.
- **Tracker** — `data/applications.md`: пользовательская история откликов (пишется через `merge-tracker.mjs`/`set-status.mjs`); расхождения с SQLite нужно диагностировать и восстанавливать, не переотправляя форму.
- **url_key** — нормализованный URL вакансии, по которому обнаруживаются повторы. Повторы компания+роль между разными ATS дополнительно требуют сверки.
- **Claim / Lease** — атомарная аренда вакансии в SQLite (`next`, `renew`, `release`, `defer`), чтобы разные workers не откликались одновременно. Просроченная аренда сама возвращается в очередь, поэтому неопределённый результат Submit нельзя автоматически переотправлять.
- **Queue status** — `queued`, `claimed`, `applied`, `submitted_unconfirmed`, `validation_failed`, `failed`, `captcha`, `skipped`. `needs_user_action` — смысл причины остановки в заметке, **не отдельный канонический статус SQLite**.
- **Applied / Подтверждённо отправлено** — статус только с квитанцией детерминированного верификатора. `submitted_unconfirmed` означает «возможно отправлено, не повторять без выяснения».
- **Evidence receipt** — локальная запись из `autopilot-verify.mjs begin|finish`, связывает конкретный URL, попытку и результат после Submit; LLM не может объявить успех без неё.
- **Ranking / Wide funnel** — приоритет 0–100 от `autopilot-ranking.mjs`, а не гарантированный фильтр пригодности. Настройки рынка и blacklist могут отдельно исключать записи.
- **Resume resolver** — `autopilot-resume.mjs`: выбирает проверенный PDF по JD/специализации, затем fallback; способен принимать tailored PDF, если он создан и прошёл проверку.
- **JD** — Job Description, полный текст вакансии, который нужно открыть перед выбором резюме и сопроводительного.

## Авторизация, текст и почта

- **Auth flow** — вход или регистрация на карьерном сайте с разрешёнными методами: существующая браузерная сессия → email magic-link/OTP → при невозможности — задача пользователю. Новый пароль, SMS, CAPTCHA и 2FA не угадываются и не обходятся.
- **Email OTP / Magic link** — одноразовый код или ссылка подтверждения. `autopilot-mail.mjs wait --domain <sender-host> --since <unix-seconds> [--url-host <site-host>]` читает **только свежие** письма из авторизованного Gmail OAuth, проверяет `From` и DMARC, ничего не отправляет и не записывает секрет в лог. Нужен действующий Gmail refresh token со scope на чтение.
- **Gmail flow** — существующий `gmail-flow.mjs` отдельно умеет ingest вакансий и отправку писем; **не доказывает**, что пользователь локально настроил Gmail. Auto-send писем работодателям не включается неявно.
- **Humanizer** — `humanizer-bridge.py`/`lib/humanizer.mjs`: помогает генерировать и валидировать сопроводительное/свободные ответы; не источник личных фактов. Отсутствие Python/framework явно отмечается, а не маскируется успехом.
- **HeadHunter scope exclusion** — HH, hh-ops и HH API не используются этим автономным runner; для них существует независимый проект.

## Логи, восстановление, команды

- **Audit JSONL** — `data/autopilot/logs/YYYY-MM-DD.jsonl` (`autopilot-log.mjs`), событийный технический журнал с редактированием чувствительных полей. **Нельзя публиковать сырые JSONL, браузерные traces, cookie, OTP, token или DB.**
- **Run report** — `data/autopilot/reports/<run-id>.json`: счётчики/статусы/длительность. Личные данные в него не включаются.
- **Sanitized diagnostics** — `npm run autopilot:diagnose`: экспорт строго разрешённых числовых счётчиков, кодов ошибок и типа агента. Даже этот результат нужно просмотреть перед публикацией.
- **Recovery** — возврат в очередь только до нажатия Submit при известной безопасной ошибке. После сомнительного Submit блокируется повтор и фиксируется ошибка для разбора.
- **Dry run** — `npm run autopilot -- --dry-run`: проверяет уже имеющуюся очередь без запуска браузера, взятия leases и отправок. Это режим диагностики, а не основной продукт.
- **Live start** — `npm run autopilot` (одна команда, реальный автономный режим). Для ограниченного прогона `npm run autopilot -- --max-jobs 2`; для повторного сканирования компаний `--refresh-registry`; при уже подготовленной очереди `--no-scan`.
- **Scanner only** — `npm run autopilot:scan`: прежняя CLI-подготовка очереди без coding-agent; теперь внутренний строительный блок.
- **Browser E2E** — `npm run test:autopilot:browser`: тестовое приложение без настоящих откликов. Только он может проверить интеграцию CLI/Chromium/верификатора на данном компьютере.
- **Scheduler** — внешняя настройка cron/Task Scheduler/launchd. Запись в markdown **не запускает фоновые процессы**.

## Upstream

Оригинал: https://github.com/career-ops-hq/career-ops . Он ориентирован на **review-first** (`apply` не отправляет). Наш форк сохраняет reusable провайдеры, scoring, контракты приватных данных, инструменты PDF и тесты, но принципиально отличается главным сценарием — **autonomous browser submit with evidence**. Не копировать обратно upstream-правило «never submits» в Autopilot. Встроенная старая web/apply preview-ветка до интеграции с runner остаётся неавтономной и не является главной точкой запуска.
