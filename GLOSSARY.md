# GLOSSARY — словарь терминов career-ops

> Чтобы человек и агент понимали друг друга однозначно. Определения — из фактического
> кода (autopilot-db.mjs, autopilot.mjs, ARCHITECTURE.md, DATA_CONTRACT.md), не из upstream-доков.
> Обновляй при добавлении новых сущностей. Дата: 2026-10-21.

## Проект в одном абзаце

Локальный форк open-source системы поиска работы (`orelkrylatiy/career-ops`, upstream ушёл
на ~1000 файлов вперёд — синхронизация только вручную). Сканирует 100+ порталов и ATS-API
без LLM-токенов, складывает вакансии в широкую SQLite-очередь, а автопилот-режим даёт
кодинг-агенту (Claude Code и др.) арендовать работу и самому водить Chromium через
Playwright: заполнить форму отклика, детерминированно верифицировать сабмит и только
потом записать «Applied». Демона нет — цикл запускается вручную или внешним планировщиком.

## Ядро: хранилища и контракт данных

- **Файлы каноничны, БД производная** — главный инвариант (ARCHITECTURE.md:24):
  `data/*.md` — источник истины, `data/autopilot.db` — журнал/срез, который можно
  перестроить.
- **User layer / System layer** (DATA_CONTRACT.md) — двухслойный контракт:
  user layer (`config/profile.yml`, `cv.md`, `modes/_profile.md`, трекер) принадлежит
  человеку, апдейтер его не трогает; system layer — генерируется/обновляется системой.
- **Tracker (трекер)** — `data/applications.md`, каноническая таблица откликов:
  `# | Date | Company | Role | Score | Status | PDF | Report | Notes`.
  Пишется ТОЛЬКО через `merge-tracker.mjs` (из TSV в `batch/tracker-additions/`) и
  `set-status.mjs` — руками строки не добавлять.
- **Tracker-статусы** (`templates/states.yml`, канон): `Evaluated` (оценена), `Applied`
  (отклик отправлен подтверждённо), `Responded` (ответили), `Interview`, `Offer`,
  `Hired`, `Rejected`, `Discarded`, `SKIP`.
- **Pipeline (инбокс)** — `data/pipeline.md`, чек-листы URL входящих вакансий
  (`- [ ] URL | Company | Role | Location | posted:`). Стадия до оценки.
- **Queue file** — `data/autopilot-queue.md`, человекочитаемый срез очереди с
  приоритетами вида `[P95]`. Производный от SQLite.
- **Blacklist** — `data/blacklist.md`, компании do-not-apply; уважается сканом и гейтами.
- **url_key** — канонический ключ вакансии (host lowercase, трекинг-параметры срезаны,
  см. `url-key.mjs normalizeUrl`). Единый механизм дедупа между очередью и трекером.

## Очередь и автопилот

- **Autopilot** — opt-in автономный режим форка: wide-funnel очередь + Playwright CLI +
  детерминированная верификация сабмита (`autopilot.mjs`, `modes/autopilot.md`,
  `docs/AUTOPILOT_ARCHITECTURE.md`). «Кодинг-агент — мозг, скрипты — детерминированное
  состояние». В этом форке автопилот УМЕЕТ сабмитить (старые доки «never submits» —
  наследие upstream).
- **Job** — строка таблицы `jobs` в `data/autopilot.db`: url_key (PK), url, source,
  company, title, location, status, priority, rank_reasons, posted_at.
- **Job-статусы**: `queued → claimed → applied | submitted_unconfirmed |
  validation_failed | failed | captcha | skipped`.
- **Claim / lease (аренда)** — атомарный захват джобы воркером:
  `npm run autopilot:next -- --owner worker-0 --lease-minutes 120`;
  есть `renew` (продлить), `release` (освободить), `defer` (отложить). Аренды истекают
  сами — умерший воркер не блокирует очередь.
- **Ranking** — `autopilot-ranking.mjs scoreJob()`: приоритет 0..100 («мягкий»:
  title_match, russia_market, fresh_2d и т.п.). НИКОГДА не отклоняет джобу —
  wide-funnel: всё попадает в очередь, приоритет решает только порядок.
- **Application (в БД)** — строка `applications`: job_url_key, channel (`browser` —
  единственный), ats, resume_variant, resume_path, duration_ms, outcome, details.
- **Evidence receipt (квитанция)** — доказательство сабмита от верификатора:
  `autopilot-verify.mjs begin|finish`, файлы в `data/autopilot/evidence/`. Статус
  `applied` ставится ТОЛЬКО при подтверждённой квитанции; иначе
  `submitted_unconfirmed` (сабмит, который не удалось доказать) или
  `validation_failed`.
- **Resume resolver** — `autopilot-resume.mjs`: детерминированный выбор PDF-варианта
  из `output/resumes/` (`general|frontend|ai-engineer` × `ru|en`) → флаг
  `--generated` (сгенерировать) → legacy-настройка.
- **daily_state** — таблица суточных счётчиков подтверждённых откликов (для лимитов).
- **events** — append-only журнал в БД (ts, level, category: queue/report/run/scan,
  message). `llm_calls` — таблица учёта LLM-трат (в этой инсталляции пустая — spend
  не логируется).

## Поиск и оценка

- **Portal** — источник вакансий из `portals.yml` (компания + поисковые запросы).
- **Provider** — модули в `providers/` под конкретное ATS или job board
  (Greenhouse, Ashby, Lever, Workday, …).
- **Scan** — zero-token сканирование порталов (`scan.mjs`, `scan-ats-full.mjs`
  reverse-ATS). История: `data/scan-history.tsv`, прогоны: `data/scan-runs.tsv`,
  здоровье порталов: `data/portal-health.tsv`.
- **Report** — отчёт об оценке вакансии `reports/{NNN}-{company-slug}-{YYYY-MM-DD}.md`:
  оценка блоками A–H, score 1–5, обязательные `**URL:**`, `**Legitimacy:**` и секция
  с вербатим-JD. Файлы-имена с номером выше текущего без содержимого = RESERVED
  (застоявшиеся резервации номеров).
- **Batch** — параллельная оценка воркерами (`claude -p` / `opencode run`):
  `batch/batch-prompt.md` + `batch-runner.sh` + `batch-state.tsv`;
  `reserve-report-num.mjs` бронирует номера отчётов.
- **Tailor** — подгонка CV под вакансию (`openai-tailor.mjs`, `batch-tailor.mjs
  --min-score N`).
- **JD capture** — архив текста вакансии в `jds/`, желательно с `--report=N`.

## Режимы и прочее

- **Mode** — 47 сценариев в `modes/*.md` (oferta, pdf, cover, apply, scan, batch,
  triage, contacto, reply-watch, followup, outcome, autopilot, …) — инструкции для
  кодинг-агента.
- **Worker** — headless CLI-воркер, арендующий джобы. **Browser profile** —
  persistent Chromium-профиль `data/browser-profile/` (залогиненные сессии; ~364 МБ).
- **LLM-слой** — свой прямой HTTP: `openai-eval.mjs` /
  `openai-tailor.mjs` → OpenAI-совместимый endpoint из `.env`
  (`OPENAI_BASE_URL=https://api.z.ai/api/coding/paas/v4`, `OPENAI_MODEL=GLM-5.3-Flash`).
  Один endpoint на запуск, без цепочек фолбэков. Альтернативы: `gemini-eval.mjs`,
  `ollama-eval.mjs`.
- **Humanizer-framework** (Python, `Desktop\projects\humanizer-framework`) — голос +
  валидация текстов «для людей». Мост: `humanizer-bridge.py` (write/validate/selfcheck)
  + `lib/humanizer.mjs` (soft-fail null). Гейты в `modes/cover.md` (Step 8b) и
  `modes/apply.md` (Step 7). Персона — `voice-dna.md` → VoiceProfile. Оффлайн-валидатор
  без LLM-вызова; генерация — через цепочку OpenCode → GLM → OpenAI API.
- **Полезные команды**: `npm run autopilot` (обновить очередь), `autopilot:status`,
  `autopilot:next -- --json` (выдать работу), `autopilot:analytics` (воронка),
  `autopilot:browser:doctor`. Остановка автопилота — Ctrl+C (kill-switch нет).
