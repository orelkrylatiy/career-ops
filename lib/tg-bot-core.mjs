/**
 * tg-bot-core.mjs — pure routing/rendering for the career-ops Telegram bot.
 *
 * No network, no timers: handleUpdate() takes one Telegram update plus a
 * context ({ registry, statsFor, recentRows }) and returns the list of Bot
 * API calls to make. tg-bot.mjs is the thin polling/executing shell; every
 * behaviour here is unit-testable offline (tests/tg-bot-core.test.mjs).
 *
 * Identity model (mirror of lib/profile-registry.mjs): a Telegram user id
 * maps to exactly one PROFILE; a profile holds any number of DIRECTIONS
 * (analyst, designer, react, vue…), each an isolated career-ops data root.
 * Unknown ids are denied by default and told their id, so they can forward
 * it to an admin. An entry flagged admin sees every profile (/profiles).
 *
 * All text is HTML parse mode. Everything user-visible is Russian — this is
 * the client-facing surface the landing page (landing/index.html) promises.
 */

import { aggregateProfileStats } from './profile-stats.mjs';
import { slugify } from './profile-registry.mjs';

const TG_MAX = 4096;
const SAFE_MAX = 4000; // headroom for entity parsing + edit overhead

/**
 * Marker "call" for the access-request side effect. The service layer
 * intercepts it (never sent to Telegram) and appends the lead to
 * data/tg-bot-leads.json — keeping this module pure and offline-testable
 * while the lead log stays durable.
 */
export const RECORD_LEAD_METHOD = 'recordLead';

/**
 * The "main screen" image shown at onboarding entry: a screenshot of the
 * landing's Telegram digest panel (landing/assets/telegram-main-screen.png,
 * captured from landing/index.html's .telegram-panel). Repo-relative; the
 * service resolves it against the code root and degrades to plain text when
 * the file is missing.
 */
export const MAIN_SCREEN_PHOTO = 'landing/assets/telegram-main-screen.png';

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(text) {
  if (text.length <= SAFE_MAX) return text;
  return `${text.slice(0, SAFE_MAX - 20)}\n…(обрезано)`;
}

/** Map a Telegram user id onto { profile, tg, admin }, or null when unknown. */
export function identifyUser(registry, userId) {
  const id = String(userId ?? '');
  if (!id) return null;
  for (const profile of registry?.profiles ?? []) {
    for (const tg of profile.telegram ?? []) {
      if (String(tg.user_id) === id) {
        return { profile, tg, admin: !!tg.admin };
      }
    }
  }
  return null;
}

// ── keyboards ──────────────────────────────────────────────────────

const btn = (text, callback_data) => ({ text, callback_data });

export function mainMenuKeyboard(admin) {
  const rows = [
    [btn('📊 Моя статистика', 'stats'), btn('🧭 Направления', 'dirs')],
    [btn('🕘 Последние отклики', 'last'), btn('ℹ️ Кто я', 'whoami')],
  ];
  if (admin) rows.push([btn('👥 Все профили', 'profiles')]);
  return { inline_keyboard: rows };
}

export function directionListKeyboard(profile) {
  const rows = (profile?.directions ?? []).map((d) => [btn(`🧭 ${d.name}`, `dir:${profile.id}:${d.id}`)]);
  rows.push([btn('⬅️ Меню', 'menu')]);
  return { inline_keyboard: rows };
}

/** Pre-login menu: the sales surface an unknown visitor lands on (/start). */
export function onboardingKeyboard() {
  return { inline_keyboard: [
    [btn('🚀 Получить доступ', 'access')],
    [btn('📋 Как это работает', 'about')],
  ] };
}

/**
 * The onboarding wizard: five leaf-through screens (◀️ ▶️) explaining the
 * product. Content mirrors the landing page's claims exactly — same pricing
 * terms, same honesty, no invented numbers; the landing's own check enforces
 * that on the site, and the bot must not promise more than the site does.
 */
export const ONBOARDING_STEPS = [
  {
    icon: '👋',
    title: 'Career Ops — поиск работы на автопилоте',
    body: 'Мы берём на себя рутину вокруг поиска: сканеры находят вакансии, материалы '
      + 'адаптируются под конкретную роль, формы заполняются и отправляются — '
      + 'с подтверждением отправки, а не «наверное, ушло».\n\n'
      + 'Вы подключаетесь, когда начинается содержительный диалог с работодателем. '
      + 'Весь прогресс виден здесь, в Telegram.\n\n'
      + '✓ <b>Без предоплаты и подписки</b>\n'
      + '✓ Оплата — от результата, условия фиксируются до старта\n'
      + '✓ Персональная статистика только по вашему поиску\n\n'
      + 'Листайте вперёд, чтобы посмотреть, как это работает →',
  },
  {
    icon: '💪',
    title: 'Зачем это нужно',
    body: 'Снимаем не поиск работы. Снимаем рутину вокруг него.\n\n'
      + '<b>1. Ваше время возвращается вам.</b> Не нужно каждый вечер листать вакансии, '
      + 'копировать одно и то же и заполнять похожие формы.\n'
      + '<b>2. Охват становится системным.</b> Поиск не зависит от настроения, загруженности '
      + 'или того, успели ли вы сегодня проверить новые вакансии.\n'
      + '<b>3. Резюме не теряется в потоке.</b> Материалы и формулировки адаптируются под '
      + 'конкретную роль, а не одна версия «на все случаи».\n'
      + '<b>4. Вы видите воронку.</b> Не «кажется, что я много откликаюсь», а понятная картина: '
      + 'сколько отправлено, сколько ответили и где появились интервью.',
  },
  {
    icon: '🔎',
    title: 'Как это работает — поиск',
    body: '<b>1. Находим вакансии.</b> Сканеры регулярно проходят по порталам и бордам; '
      + 'подходящие попадают в поток.\n\n'
      + '<b>2. Подстраиваем материалы.</b> Выбираем подходящий вариант резюме, когда нужно — '
      + 'персональную версию под роль.',
  },
  {
    icon: '📤',
    title: 'Как это работает — отклики и прогресс',
    body: '<b>3. Заполняем и отправляем.</b> Проходим форму, прикладываем резюме, фиксируем '
      + 'результат. Заявка не считается отправленной без подтверждения.\n\n'
      + '<b>4. Показываем прогресс.</b> Отклики, ответы и приглашения собираются в понятную '
      + 'статистику — как на скриншоте в начале.',
  },
  {
    icon: '💰',
    title: 'Условия',
    body: '• Без предоплаты: сначала работа, потом оплата.\n'
      + '• Модель: 50% от оффера, если через процесс было хотя бы одно собеседование. '
      + 'База расчёта и момент оплаты фиксируются до запуска.\n'
      + '• Оффер не гарантируем — найм решает работодатель; мы отвечаем за объём и качество '
      + 'операционной работы.\n'
      + '• Поиск можно остановить и перенастроить в любой момент.',
  },
  {
    icon: '🔒',
    title: 'Приватность и доступ',
    body: 'Telegram — только клиентский интерфейс: бот присылает вашу статистику и события. '
      + 'Доступ к личной переписке не нужен и не запрашивается.\n\n'
      + 'Статистика личная, доступ — по заявке: нажмите «🚀 Получить доступ», '
      + 'и администратор вам ответит.',
  },
];

export function renderStep(index) {
  const i = Math.max(0, Math.min(index, ONBOARDING_STEPS.length - 1));
  const s = ONBOARDING_STEPS[i];
  return `${s.icon} <b>${s.title}</b>\n\n${s.body}\n\n<i>Шаг ${i + 1} из ${ONBOARDING_STEPS.length}</i>`;
}

/** Paging keyboard: ◀️ [n/total] ▶️ + the access CTA (+ menu row for known users). */
export function stepKeyboard(index, { known = false } = {}) {
  const last = ONBOARDING_STEPS.length - 1;
  const i = Math.max(0, Math.min(index, last));
  const nav = [];
  if (i > 0) nav.push(btn('◀️', `step:${i - 1}`));
  nav.push(btn(`${i + 1}/${ONBOARDING_STEPS.length}`, 'noop'));
  if (i < last) nav.push(btn('▶️', `step:${i + 1}`));
  const rows = [nav, [btn('🚀 Получить доступ', 'access')]];
  if (known) rows.push([btn('🏠 Меню', 'menu')]);
  return { inline_keyboard: rows };
}

const detailKeyboard = () => ({ inline_keyboard: [
  [btn('⬅️ Направления', 'dirs')],
  [btn('🏠 Меню', 'menu')],
] });

// ── renderers (pure; HTML) ─────────────────────────────────────────

const fmtCount = (n) => String(n ?? 0);

function directionLine(d, stats) {
  const name = escapeHtml(d.name);
  if (!stats?.tracker) return `🧭 <b>${escapeHtml(d.id)}</b> (${name}) — данных пока нет`;
  const f = stats.funnel ?? {};
  return `🧭 <b>${escapeHtml(d.id)}</b> (${name}): отклики ${fmtCount(f.everApplied)}`
    + ` · ответы ${fmtCount(f.everResponded)} · интервью ${fmtCount(f.everInterview)} · офферы ${fmtCount(f.everOffer)}`;
}

export function renderWelcome({ ident }) {
  const { profile, admin } = ident;
  return `👋 <b>Career Ops</b> — статистика вашего поиска\n\n`
    + `Вы: <b>${escapeHtml(profile.name)}</b> · профиль <b>${escapeHtml(profile.id)}</b>`
    + ` · направлений: <b>${profile.directions.length}</b>${admin ? ' · админ' : ''}\n\n`
    + 'Выберите кнопку ниже или команду:\n'
    + '📊 /stats — сводка по всем направлениям\n'
    + '🧭 /dirs — детально по каждому направлению\n'
    + '🕘 /last — последние отклики\n'
    + 'ℹ️ /whoami — кто вы в системе';
}

export function renderNoAccess(userId) {
  return '🚫 <b>Нет доступа.</b>\n\n'
    + `Ваш Telegram ID: <code>${escapeHtml(userId ?? '—')}</code>\n`
    + 'Доступ выдаёт администратор по заявке: /start → «Получить доступ».\n'
    + 'Или попросите добавить вас вручную:\n'
    + `<code>node profile.mjs add-profile &lt;slug&gt; --name "Имя" --tg ${escapeHtml(userId ?? '')}</code>`;
}

/**
 * What each admin receives when an unknown visitor requests access. Includes
 * a ready-to-paste add-profile command (slug from the visitor's Telegram
 * name when it transliterates, id placeholder otherwise).
 */
export function renderAccessRequestForAdmin({ userId, name, username }) {
  const slug = slugify(name || username || '') ?? 'client';
  const idLine = `Telegram ID: <code>${escapeHtml(userId)}</code>`;
  const nameLine = name ? `Имя: ${escapeHtml(name)}` : null;
  const userLine = username ? `Username: @${escapeHtml(username)}` : null;
  return [
    '🔔 <b>Новая заявка на доступ</b>',
    '',
    ...[nameLine, userLine, idLine].filter(Boolean),
    '',
    'Добавить профиль:',
    `<code>node profile.mjs add-profile ${escapeHtml(slug)} --name "Имя" --tg ${escapeHtml(userId)}</code>`,
  ].join('\n');
}

export function renderProfileStats({ ident, dirEntries }) {
  const { profile } = ident;
  const aggregate = aggregateProfileStats(dirEntries.map((e) => e.stats));
  const lines = [`👤 <b>${escapeHtml(profile.name)}</b> — направлений: <b>${profile.directions.length}</b>`, ''];
  dirEntries.forEach((entry) => lines.push(directionLine(entry.direction, entry.stats)));
  lines.push('');
  if (aggregate.funnel) {
    const f = aggregate.funnel;
    lines.push(`Σ по профилю: отклики <b>${f.everApplied}</b> · интервью <b>${f.everInterview}</b> · офферы <b>${f.everOffer}</b>`
      + ` · в работе <b>${aggregate.tracker.activeApps}</b>`);
    lines.push(`Конверсия: ответы ${f.responseRate}% · интервью ${f.interviewRate}% · офферы ${f.offerRate}%`);
  } else {
    lines.push('Σ по профилю: данных пока нет — направления без трекеров.');
  }
  return lines.join('\n');
}

export function renderDirectionList({ profile }) {
  const lines = [`🧭 Направления профиля <b>${escapeHtml(profile.name)}</b>:`, ''];
  profile.directions.forEach((d, i) => lines.push(`${i + 1}. ${escapeHtml(d.name)} (<code>${escapeHtml(d.id)}</code>)`));
  lines.push('', 'Нажмите на направление ниже — покажу детальную статистику.');
  return lines.join('\n');
}

export function renderDirectionDetail({ profile, direction, stats }) {
  if (!stats?.tracker) {
    return `🧭 <b>${escapeHtml(direction.name)}</b> (${escapeHtml(profile.name)})\n\n`
      + 'Данных пока нет: трекер пуст. Как только появятся отклики — здесь будет статистика.';
  }
  const t = stats.tracker;
  const f = stats.funnel ?? {};
  const lines = [
    `🧭 <b>${escapeHtml(direction.name)}</b> · профиль ${escapeHtml(profile.name)}`,
    '',
    `Записей в трекере: <b>${t.total}</b> · в работе: <b>${t.activeApps}</b>`,
    `Отклики: <b>${f.everApplied ?? 0}</b> · ответы: ${fmtCount(f.everResponded)} (${f.responseRate ?? 0}%)`
      + ` · интервью: ${fmtCount(f.everInterview)} (${f.interviewRate ?? 0}%) · офферы: ${fmtCount(f.everOffer)}`,
  ];
  const byStatus = Object.entries(t.byStatus ?? {}).filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}: ${n}`).join(' · ');
  if (byStatus) lines.push(`Статусы: ${escapeHtml(byStatus)}`);
  if (stats.runs) {
    lines.push(`Сканы: ${stats.runs.totalRuns} прогонов · в среднем ${stats.runs.avgFoundPerRun} найдено / ${stats.runs.avgNewPerRun} новых`);
  }
  return lines.join('\n');
}

export function renderLastRows(rows) {
  if (!rows?.length) return '🕘 В трекерах ваших направлений пока нет записей.';
  const lines = ['🕘 <b>Последние отклики:</b>', ''];
  for (const row of rows) {
    lines.push(`• <code>${escapeHtml(row.date ?? '—')}</code> [${escapeHtml(row.direction)}] `
      + `<b>${escapeHtml(row.company)}</b> — ${escapeHtml(row.role)} (${escapeHtml(row.status)})`);
  }
  return lines.join('\n');
}

export function renderWhoami({ ident }) {
  const { profile, tg, admin } = ident;
  return `ℹ️ Telegram ID: <code>${escapeHtml(tg.user_id)}</code>\n`
    + `Профиль: <b>${escapeHtml(profile.id)}</b> (${escapeHtml(profile.name)})\n`
    + `Направлений: <b>${profile.directions.length}</b>`
    + (profile.directions.length ? `: ${profile.directions.map((d) => escapeHtml(d.id)).join(', ')}` : '')
    + `\nПрава: ${admin ? 'админ — виден раздел «Все профили»' : 'только свой профиль'}`;
}

export function renderProfilesList({ registry, aggregates }) {
  const totalDirections = registry.profiles.reduce((n, p) => n + p.directions.length, 0);
  const sum = (key) => aggregates.reduce((n, a) => n + (a?.funnel?.[key] ?? 0), 0);
  const lines = [
    `👥 Профилей: <b>${registry.profiles.length}</b> · направлений: <b>${totalDirections}</b>`
    + ` · откликов всего: <b>${sum('everApplied')}</b>`,
    '',
  ];
  registry.profiles.forEach((p, i) => {
    const a = aggregates[i];
    const f = a?.funnel;
    const tail = f
      ? `${f.everApplied} откл. · ${f.everInterview} инт. · ${f.everOffer} офф.`
      : 'нет данных';
    lines.push(`• <b>${escapeHtml(p.id)}</b> (${escapeHtml(p.name)}) — ${p.directions.length} напр., ${tail}`);
  });
  return lines.join('\n');
}

// ── routing ────────────────────────────────────────────────────────

function sendMessage(chatId, text, keyboard) {
  return {
    method: 'sendMessage',
    payload: {
      chat_id: chatId,
      text: truncate(text),
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    },
  };
}

function editMessageText(chatId, messageId, text, keyboard) {
  return {
    method: 'editMessageText',
    payload: {
      chat_id: chatId,
      message_id: messageId,
      text: truncate(text),
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    },
  };
}

function sendPhoto(chatId, caption) {
  return {
    method: 'sendPhoto',
    photoPath: MAIN_SCREEN_PHOTO,
    payload: { chat_id: chatId, caption: truncate(caption), parse_mode: 'HTML' },
  };
}

/** '/stats@my_bot extra' → '/stats'. */
export function normalizeCommand(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? '';
  return first.replace(/@[A-Za-z0-9_]+$/, '').toLowerCase();
}

function dirEntriesFor(ctx, profile) {
  return profile.directions.map((direction) => ({ direction, stats: ctx.statsFor(profile.id, direction.id) ?? null }));
}

/** Handle one Telegram update; returns Bot API calls to execute. Never throws on bad input. */
export function handleUpdate(update, ctx) {
  try {
    if (update?.message?.text !== undefined) return handleMessage(update.message, ctx);
    if (update?.callback_query) return handleCallback(update.callback_query, ctx);
    return [];
  } catch (err) {
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    if (chatId === undefined) return [];
    return [sendMessage(chatId, `⚠️ Внутренняя ошибка обработки: ${escapeHtml(err.message)}`)];
  }
}

/** Every admin telegram id in the registry (recipients of access requests). */
export function collectAdminIds(registry) {
  const ids = new Set();
  for (const profile of registry?.profiles ?? []) {
    for (const tg of profile.telegram ?? []) {
      if (tg.admin) ids.add(String(tg.user_id));
    }
  }
  return [...ids];
}

function handleMessage(message, ctx) {
  const chatId = message.chat?.id;
  if (chatId === undefined) return [];
  const command = normalizeCommand(message.text);

  // Pre-login surface: the pitch, the wizard, the access request.
  // Stats stay deny-by-default — only these screens are public.
  const ident = identifyUser(ctx.registry, message.from?.id);
  if (!ident) {
    if (command === '/start' || command === '/help') {
      return [
        sendPhoto(chatId, 'Это главный экран вашего поиска — статистика приходит сюда, в Telegram 👇'),
        sendMessage(chatId, renderStep(0), stepKeyboard(0)),
      ];
    }
    if (command === '/about') {
      return [sendMessage(chatId, renderStep(0), stepKeyboard(0))];
    }
    return [sendMessage(chatId, renderNoAccess(message.from?.id))];
  }

  switch (command) {
    case '/start':
    case '/help':
      return [sendMessage(chatId, renderWelcome({ ident }), mainMenuKeyboard(ident.admin))];
    case '/stats':
      return [sendMessage(chatId, renderProfileStats({ ident, dirEntries: dirEntriesFor(ctx, ident.profile) }), mainMenuKeyboard(ident.admin))];
    case '/dirs':
    case '/directions':
      return [sendMessage(chatId, renderDirectionList({ profile: ident.profile }), directionListKeyboard(ident.profile))];
    case '/last':
      return [sendMessage(chatId, renderLastRows(ctx.recentRows(ident.profile.id, 8)), mainMenuKeyboard(ident.admin))];
    case '/whoami':
      return [sendMessage(chatId, renderWhoami({ ident }), mainMenuKeyboard(ident.admin))];
    case '/about':
      return [sendMessage(chatId, renderStep(0), stepKeyboard(0, { known: true }))];
    case '/ping':
      return [sendMessage(chatId, '🏓 pong')];
    case '/profiles':
      if (!ident.admin) {
        return [sendMessage(chatId, '🚫 Раздел только для админов. Ваша статистика: /stats')];
      }
      return [sendMessage(chatId, renderProfilesList({
        registry: ctx.registry,
        aggregates: ctx.registry.profiles.map((p) => aggregateProfileStats(dirEntriesFor(ctx, p).map((e) => e.stats))),
      }), mainMenuKeyboard(true))];
    default:
      return [sendMessage(chatId, 'Не понял команду. Доступно: /stats · /dirs · /last · /whoami · /ping' + (ident.admin ? ' · /profiles' : ''))];
  }
}

function handleCallback(callbackQuery, ctx) {
  const calls = [{ method: 'answerCallbackQuery', payload: { callback_query_id: callbackQuery.id } }];
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  if (chatId === undefined) return calls;

  const ident = identifyUser(ctx.registry, callbackQuery.from?.id);
  const data = String(callbackQuery.data ?? '');
  const reply = (text, keyboard) => {
    // editMessageText fails on "message is not modified" and on messages too
    // old; the service layer falls back to sendMessage when edit errors, so
    // core always prefers the in-place edit.
    calls.push(messageId
      ? editMessageText(chatId, messageId, text, keyboard)
      : sendMessage(chatId, text, keyboard));
  };
  const toast = (text) => {
    calls[0].payload.text = text;
  };

  // Pre-login callbacks: browse the wizard, request access. Nothing else.
  if (!ident) {
    if (data.startsWith('step:')) {
      const n = Number.parseInt(data.slice(5), 10);
      if (Number.isInteger(n)) reply(renderStep(n), stepKeyboard(n));
    } else if (data === 'noop') {
      // progress pill — nothing to answer beyond the default toast
    } else if (data === 'about' || data === 'menu') {
      reply(renderStep(0), stepKeyboard(0));
    } else if (data === 'access') {
      const userId = String(callbackQuery.from?.id ?? '');
      if (!userId) {
        toast('⚠️ Не удалось определить ваш Telegram ID.');
      } else if (ctx.leads?.has(userId)) {
        toast('Заявка уже отправлена — администратор свяжется с вами.');
      } else {
        const admins = collectAdminIds(ctx.registry);
        if (admins.length === 0) {
          toast('⚠️ Администратор не настроен. Напишите ваш ID админу вручную.');
        } else {
          const info = {
            userId,
            name: callbackQuery.from?.first_name,
            username: callbackQuery.from?.username,
          };
          for (const adminId of admins) {
            calls.push(sendMessage(adminId, renderAccessRequestForAdmin(info)));
          }
          calls.push({ method: RECORD_LEAD_METHOD, payload: { ...info, at: ctx.now ?? new Date().toISOString() } });
          toast('✅ Заявка отправлена. Администратор добавит вас и напишет.');
        }
      }
    } else {
      calls.push(sendMessage(chatId, renderNoAccess(callbackQuery.from?.id)));
    }
    return calls;
  }

  if (data.startsWith('dir:')) {
    const [, profileId, directionId] = data.split(':');
    const profile = ident.admin ? (ctx.registry.profiles.find((p) => p.id === profileId) ?? ident.profile) : ident.profile;
    if (profile.id !== profileId) {
      reply('🚫 Это направление другого профиля.', detailKeyboard());
      return calls;
    }
    const direction = profile.directions.find((d) => d.id === directionId);
    if (!direction) {
      reply('Направление не найдено — возможно, его удалили.', directionListKeyboard(profile));
      return calls;
    }
    reply(renderDirectionDetail({ profile, direction, stats: ctx.statsFor(profile.id, direction.id) ?? null }), detailKeyboard());
    return calls;
  }

  if (data.startsWith('step:')) {
    const n = Number.parseInt(data.slice(5), 10);
    if (Number.isInteger(n)) reply(renderStep(n), stepKeyboard(n, { known: true }));
    return calls;
  }

  if (data === 'noop') return calls;

  switch (data) {
    case 'menu':
      reply(renderWelcome({ ident }), mainMenuKeyboard(ident.admin));
      break;
    case 'stats':
      reply(renderProfileStats({ ident, dirEntries: dirEntriesFor(ctx, ident.profile) }), mainMenuKeyboard(ident.admin));
      break;
    case 'dirs':
      reply(renderDirectionList({ profile: ident.profile }), directionListKeyboard(ident.profile));
      break;
    case 'last':
      reply(renderLastRows(ctx.recentRows(ident.profile.id, 8)), mainMenuKeyboard(ident.admin));
      break;
    case 'whoami':
      reply(renderWhoami({ ident }), mainMenuKeyboard(ident.admin));
      break;
    case 'about':
      reply(renderStep(0), stepKeyboard(0, { known: true }));
      break;
    case 'access':
      toast('✅ Вы уже внутри — ваша статистика в меню.');
      break;
    case 'profiles':
      if (!ident.admin) {
        reply('🚫 Раздел только для админов.', mainMenuKeyboard(false));
        break;
      }
      reply(renderProfilesList({
        registry: ctx.registry,
        aggregates: ctx.registry.profiles.map((p) => aggregateProfileStats(dirEntriesFor(ctx, p).map((e) => e.stats))),
      }), mainMenuKeyboard(true));
      break;
    default:
      reply('Неизвестная кнопка.', mainMenuKeyboard(ident.admin));
  }
  return calls;
}
