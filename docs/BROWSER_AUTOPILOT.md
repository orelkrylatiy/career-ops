# Browser Autopilot: запуск и эксплуатация

## Область действия

Career Ops — **автономная отправка откликов через настоящий браузер** на карьерных сайтах/независимых агрегаторах. **HeadHunter (hh.ru, hh.kz, hh.uz) и hh-ops не участвуют ни в discovery, ни в apply.** Проект не вызывает HH API, и отдельный HH репозиторий не является зависимостью. Оригинальный [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) review-first; этот форк использует его провайдеры, контракты данных и инструменты, но меняет способ запуска.

Архитектура: `scan-regional.mjs --country RU` → `autopilot.mjs --no-scan` → SQLite lease → coding-agent в CLI → Playwright CLI → `autopilot-verify.mjs begin/finish` → `autopilot.mjs report` → следующий lease → JSON отчёт.

## Подготовка

1. Установить Node.js 22.13+ (Playwright/SQLite), `npm install`, `npx playwright install chromium` и любой **авторизованный** coding CLI: Claude Code, Codex или OpenCode.
2. Настроить приватные `config/profile.yml`, `cv.md`, PDF резюме и по необходимости `portals.yml`. Нельзя коммитить user-layer или auth.
3. Выполнить `npm run autopilot:preflight`, `npm run autopilot:browser:doctor`, `npm run autopilot:resume`. Для реального браузера дополнительно `npm run test:autopilot:browser` (локальная тестовая форма).
4. Впервые выполнить `npm run autopilot -- --refresh-registry --max-jobs 1`; обновление CNews500 и карьерных URL может быть длительным. Потом достаточно `npm run autopilot`. Если registry уже обновлён, scanner использует сохранённые источники. Важное ограничение: каталог HH/getmatch без browser-provider не становится автоматически рабочим.

## Основные команды

~~~bash
npm run autopilot                       # полноценный LIVE: scan → browser apply → verify
npm run autopilot -- --agent codex      # или claude/opencode; auto выбирает первый доступный
npm run autopilot -- --max-jobs 3       # ограничить один запуск
npm run autopilot -- --no-scan          # только уже поставленные в очередь вакансии
npm run autopilot -- --refresh-registry # пересобрать реестр компаний/источников РФ
npm run autopilot -- --dry-run          # БЕЗ submit, browser, claims или нового scan
npm run autopilot:status
npm run autopilot:diagnose              # экспорт только безопасных полей
npm run autopilot:logs                 # локальный журнал (НЕ публиковать)
~~~

Переменные: `AUTOPILOT_WORKER_ID` задаёт уникального владельца lease, `AUTOPILOT_RUN_ID` — ID запуска. В `--no-scan` режиме должен существовать готовый `data/autopilot.db` с заданиями. Run reports: `data/autopilot/reports/*.json`, события: `data/autopilot/logs/*.jsonl`. Их не нужно добавлять в Git.

## Browser и агент

Каждая вакансия обрабатывается отдельным завершённым non-interactive вызовом агента; runner ждёт результат, смотрит **фактическое состояние SQLite**, а не утверждение модели. Время на одну вакансию по умолчанию 25 минут (`--timeout-minutes`, максимум 110). При выходе агента без outcome runner отмечает `failed / requires review`, **не возвращает вакансии на повторный Submit**. Просроченные leases после сбоя также переводятся в review вместо автоматической переотправки.

CLI запускаются с автономными разрешениями на shell/browser. **Работать только под выделенным непривилегированным пользователем/изолированной средой, с минимально доступными секретами и ресурсами**: кодинг-агент видит сторонние страницы, которые могут содержать prompt injection. Не использовать root или персональную рабочую станцию со множеством секретов. Логи и Playwright traces локальные, не публикуются.

Нормальный путь: открыть JD, проверить blacklist и дубли, подобрать реальное CV, подготовить профильное письмо (Humanizer, если доступен), заполнить поля, перед Submit вызвать `autopilot-verify.mjs begin`, затем `finish`, затем `node autopilot.mjs report ... applied --evidence ... --owner worker-0`. Нельзя писать `Applied` без доказательства.

## Gmail и регистрация

Опционально включить Gmail OAuth с доступом на чтение почты: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` в локальном `.env`. При настройке токена требуются права Gmail read (например, `gmail.readonly`). После подключения: `npm run autopilot:mail:doctor`.

При email-registration сначала используют уже авторизованную сессию. Если сайт прислал magic link/OTP, воркер получает timestamp **перед запросом кода**, определяет реальный домен отправителя и официальный host страницы подтверждения, затем вызывает:

~~~bash
node autopilot-mail.mjs wait --domain accounts.example.org --url-host careers.example.org --since 1793080000 --timeout 120
~~~

Здесь timestamp — **образец синтаксиса**, вместо него нужен текущий Unix timestamp в секундах. Поиск ограничен 15 минутами, проверяет реальный `From` и DMARC `pass`, возвращает только код и/или ссылку с разрешённого host, ничего не помечает прочитанным и не отправляет. Этот секрет виден только локальному terminal/worker, никогда не должен попадать в logs, PR и Git.

Новый пароль, CAPTCHA, SMS, 2FA, оплата или непонятные обязательные юридические согласия не обходятся. Сохраняется блокер, обработка продолжается на следующей вакансии. `needs_user_action` пока фиксируется текстом причины, а не отдельным статусом SQLite.

## Тестирование и поддержка

- `npm run test:autopilot:browser` проверяет Playwright + fake-job form + загрузку PDF + verifier. **Не отправляет настоящие отклики.**
- `node --test tests/autopilot-runner.test.mjs tests/autopilot-mail.test.mjs tests/autopilot-diagnostics.test.mjs` проверяет маршрутизацию, OTP и отсутствие чувствительных полей в экспорте.
- `npm run autopilot:diagnose` выводит отчёт с разрешёнными полями. Для записи: `node autopilot-diagnostics.mjs 10 --output autopilot-safe.json`. Только после просмотра его можно прикладывать к issue.
- `data/autopilot/logs/`, `data/autopilot/evidence/`, `.playwright-cli/`, `.env` и `data/browser-profile/` **не загружать в GitHub**.

## Открытые ограничения (без ложного статуса Done)

- CLI runner выполняет реальные отклики только при установленном CLI/Chromium, конфиге и действующих логинах. GitHub CI не проверяет публичные сторонние ATS аккаунты.
- Legacy web Apply интерфейс исторически блокирует Submit и **не интегрирован** с новым runner; использовать CLI, пока UI не станет надёжным фасадом runner.
- Email OTP работает для разрешённых Gmail inbox и sender-доменов; автоматическая безопасная генерация и хранение паролей для регистраций не реализованы.
- Любой сайт может требовать отдельную CAPTCHA/SMS/согласие либо запрещать автоматические отклики. Не пытаться обходить.
- Браузерное обнаружение вакансий на источниках без реализованного provider — отдельное расширение. Каталог ≠ покрытие.
- Полный безопасный цикл для конкретного внешнего сайта необходимо подтвердить локальным E2E и первой фактической отправкой, а не считать закрытым по CI.

Связанные файлы: `GLOSSARY.md`, `modes/autopilot.md`, `docs/AUTOPILOT_ARCHITECTURE.md`, `autopilot-runner.mjs`, `autopilot-mail.mjs`.
