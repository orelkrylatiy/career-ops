// tests/tg-bot-core.test.mjs — the bot's pure core, offline: telegram id →
// profile identification (deny-by-default), command/callback routing, and
// the rendered stats text — against fixture stats, never the network.
//
// Run:  node --test tests/tg-bot-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleUpdate, identifyUser, normalizeCommand, renderNoAccess, renderStep,
  stepKeyboard, ONBOARDING_STEPS, renderAccessRequestForAdmin, escapeHtml,
  RECORD_LEAD_METHOD, MAIN_SCREEN_PHOTO,
} from '../lib/tg-bot-core.mjs';

const FIXTURE_STATS = {
  'maxim/analyst': {
    tracker: { total: 10, activeApps: 2, byStatus: { Applied: 5, Interview: 2, Rejected: 3 }, avgScore: 4.1 },
    funnel: { everApplied: 10, everResponded: 3, everInterview: 2, everOffer: 0, responseRate: 30, interviewRate: 20, offerRate: 0 },
  },
  'maxim/react': null, // fresh direction, no tracker yet
  'ivan/vue': {
    tracker: { total: 4, activeApps: 4, byStatus: { Applied: 4 }, avgScore: 3.9 },
    funnel: { everApplied: 4, everResponded: 0, everInterview: 0, everOffer: 0, responseRate: 0, interviewRate: 0, offerRate: 0 },
  },
};

const registry = {
  profiles: [
    {
      id: 'maxim', name: 'Maxim',
      telegram: [{ user_id: '4242', name: 'Maxim', admin: true }],
      directions: [
        { id: 'analyst', name: 'Data Analyst', created: '2026-09-23' },
        { id: 'react', name: 'React Developer', created: '2026-09-23' },
      ],
    },
    {
      id: 'ivan', name: 'Ivan',
      telegram: [{ user_id: '777', name: 'Ivan', admin: false }],
      directions: [{ id: 'vue', name: 'Vue Developer', created: '2026-09-24' }],
    },
  ],
};

const ctx = {
  registry,
  statsFor: (p, d) => FIXTURE_STATS[`${p}/${d}`] ?? null,
  recentRows: (profileId) => (profileId === 'maxim'
    ? [{ direction: 'analyst', num: '1', date: '2026-09-22', company: 'Yandex', role: 'Data Engineer', status: 'Applied' }]
    : []),
  leads: new Set(),
  now: '2026-09-23T10:00:00.000Z',
};

const msg = (fromId, text) => ({
  update_id: 1,
  message: { chat: { id: 100 }, from: { id: fromId }, text },
});
const cb = (fromId, data) => ({
  update_id: 2,
  callback_query: { id: 'cbq1', from: { id: fromId }, data, message: { chat: { id: 100 }, message_id: 55 } },
});

const firstMessage = (calls) => calls.find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');

test('identifyUser maps a telegram id to its profile, admin flag included', () => {
  const ident = identifyUser(registry, 4242);
  assert.equal(ident.profile.id, 'maxim');
  assert.equal(ident.admin, true);
  assert.equal(identifyUser(registry, '777').admin, false);
  assert.equal(identifyUser(registry, 999), null);
});

test('unknown users are denied on data commands and told their id for the admin to add', () => {
  const calls = handleUpdate(msg(999, '/stats'), ctx);
  const m = firstMessage(calls);
  assert.equal(m.method, 'sendMessage');
  assert.match(m.payload.text, /Нет доступа/);
  assert.match(m.payload.text, /999/);
  assert.match(m.payload.text, /\/start/); // pointer to the public pitch
  assert.match(renderNoAccess(999), /--tg 999/);
});

// ── onboarding: the sales surface for unknown visitors ─────────────

test('unknown /start sends the main-screen photo, then the wizard step 1 with paging', () => {
  const calls = handleUpdate(msg(999, '/start'), ctx);
  const photo = calls.find((c) => c.method === 'sendPhoto');
  assert.ok(photo, 'photo must be sent first');
  assert.equal(photo.photoPath, MAIN_SCREEN_PHOTO);
  assert.match(photo.payload.caption, /главный экран/i);
  const text = calls.find((c) => c.method === 'sendMessage');
  assert.match(text.payload.text, /поиск работы на автопилоте/);
  assert.match(text.payload.text, /Шаг 1 из 6/);
  const flat = JSON.stringify(text.payload.reply_markup);
  assert.match(flat, /step:1/); // ▶️ present on step 1, no ◀️
  assert.doesNotMatch(flat, /step:0/);
  assert.match(flat, /Получить доступ/);
});

test('the wizard: six steps, paging clamps, progress pill, CTA on every step', () => {
  assert.equal(ONBOARDING_STEPS.length, 6);
  assert.match(renderStep(0), /Шаг 1 из 6/);
  assert.match(renderStep(5), /Шаг 6 из 6/);
  assert.match(renderStep(99), /Шаг 6 из 6/); // clamped, never crashes
  assert.doesNotMatch(JSON.stringify(stepKeyboard(0)), /◀️/); // first: no back
  assert.doesNotMatch(JSON.stringify(stepKeyboard(5)), /▶️/); // last: no forward
  assert.match(JSON.stringify(stepKeyboard(2)), /3\/6/);
  for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
    assert.match(JSON.stringify(stepKeyboard(i)), /Получить доступ/, `CTA on step ${i + 1}`);
  }
  // landing-critical claims live on their steps: value, terms, privacy
  assert.match(renderStep(1), /время возвращается вам/);
  assert.match(renderStep(1), /видите воронку/);
  assert.match(renderStep(4), /50% от оффера/);
  assert.match(renderStep(4), /не гарантируем/);
  assert.match(renderStep(5), /личной переписке не нужен/);
});

test('step paging edits the message; noop answers with just the toast', () => {
  const calls = handleUpdate(cb(999, 'step:4'), ctx);
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.match(edit.payload.text, /Условия/);
  assert.match(edit.payload.text, /Шаг 5 из 6/);
  assert.match(JSON.stringify(edit.payload.reply_markup), /step:3/);

  const noop = handleUpdate(cb(999, 'noop'), ctx);
  assert.equal(noop.length, 1);
  assert.equal(noop[0].method, 'answerCallbackQuery');

  // known users can page too — their keyboard carries the menu row
  const known = handleUpdate(cb(4242, 'step:1'), ctx);
  const kEdit = known.find((c) => c.method === 'editMessageText');
  assert.match(JSON.stringify(kEdit.payload.reply_markup), /Меню/);
});

test('/about opens the wizard for unknown and known users alike', () => {
  const unknown = firstMessage(handleUpdate(msg(999, '/about'), ctx));
  assert.match(unknown.payload.text, /Шаг 1 из 6/);
  const known = firstMessage(handleUpdate(msg(4242, '/about'), ctx));
  assert.match(known.payload.text, /Шаг 1 из 6/);
  assert.match(JSON.stringify(known.payload.reply_markup), /Меню/);
});

test('access request notifies every admin with a ready add-profile command and records the lead', () => {
  const calls = handleUpdate(cb(999, 'access'), ctx);
  const adminMsg = calls.find((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === '4242');
  assert.ok(adminMsg, 'admin (4242) must be notified');
  assert.match(adminMsg.payload.text, /Новая заявка/);
  assert.match(adminMsg.payload.text, /--tg 999/);
  const lead = calls.find((c) => c.method === RECORD_LEAD_METHOD);
  assert.equal(lead.payload.userId, '999');
  assert.equal(lead.payload.at, ctx.now);
  const toast = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.match(toast.payload.text, /Заявка отправлена/);
});

test('a repeated access request does not spam admins (lead already recorded)', () => {
  const repeatCtx = { ...ctx, leads: new Set(['999']) };
  const calls = handleUpdate(cb(999, 'access'), repeatCtx);
  assert.equal(calls.length, 1); // answerCallbackQuery only
  assert.match(calls[0].payload.text, /уже отправлена/);
  assert.ok(!calls.some((c) => c.method === RECORD_LEAD_METHOD));
});

test('access-request admin text derives a slug from the visitor name', () => {
  const text = renderAccessRequestForAdmin({ userId: '555', name: 'Ivan Petrov', username: 'ivan_pt' });
  assert.match(text, /add-profile ivan-petrov --name "Имя" --tg 555/);
  assert.match(text, /@ivan_pt/);
});

test('known user clicking access is told they are already in', () => {
  const calls = handleUpdate(cb(4242, 'access'), ctx);
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.text, /уже внутри/);
});

test('/start greets the identified profile with the main menu', () => {
  const calls = handleUpdate(msg(4242, '/start'), ctx);
  const m = firstMessage(calls);
  assert.match(m.payload.text, /Maxim/);
  assert.match(m.payload.text, /направлений: <b>2<\/b>/);
  assert.equal(m.payload.parse_mode, 'HTML');
  const buttons = JSON.stringify(m.payload.reply_markup);
  assert.match(buttons, /Моя статистика/);
  assert.match(buttons, /Все профили/); // admin sees this
});

test('/stats aggregates the profile: sums across directions, honest empty lines', () => {
  const calls = handleUpdate(msg(4242, '/stats'), ctx);
  const text = firstMessage(calls).payload.text;
  assert.match(text, /отклики <b>10<\/b>/); // analyst only; react is empty
  assert.match(text, /react.*данных пока нет/s);
  assert.match(text, /интервью <b>2<\/b>/);
});

test('/dirs lists directions with one callback button each', () => {
  const calls = handleUpdate(msg(4242, '/dirs'), ctx);
  const m = firstMessage(calls);
  assert.match(m.payload.text, /Data Analyst/);
  const flat = JSON.stringify(m.payload.reply_markup);
  assert.match(flat, /dir:maxim:analyst/);
  assert.match(flat, /dir:maxim:react/);
});

test('dir callback renders detail for a direction with data', () => {
  const calls = handleUpdate(cb(4242, 'dir:maxim:analyst'), ctx);
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.callback_query_id === 'cbq1'));
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.equal(edit.payload.message_id, 55);
  assert.match(edit.payload.text, /Записей в трекере: <b>10<\/b>/);
  assert.match(edit.payload.text, /интервью: 2/);
});

test('dir callback degrades honestly for a direction without a tracker', () => {
  const calls = handleUpdate(cb(4242, 'dir:maxim:react'), ctx);
  assert.match(firstMessage(calls).payload.text, /Данных пока нет/);
});

test('admin can open another profile\'s direction; a plain user cannot', () => {
  const asAdmin = handleUpdate(cb(4242, 'dir:ivan:vue'), ctx);
  assert.match(firstMessage(asAdmin).payload.text, /Vue Developer/);
  const asUser = handleUpdate(cb(777, 'dir:maxim:analyst'), ctx);
  assert.match(firstMessage(asUser).payload.text, /другого профиля/);
});

test('/profiles is admin-only and sums every profile', () => {
  const admin = handleUpdate(msg(4242, '/profiles'), ctx);
  const text = firstMessage(admin).payload.text;
  assert.match(text, /Профилей: <b>2<\/b>/);
  assert.match(text, /направлений: <b>3<\/b>/);
  assert.match(text, /откликов всего: <b>14<\/b>/); // 10 + 4
  assert.match(text, /ivan/);

  const user = handleUpdate(msg(777, '/profiles'), ctx);
  assert.match(firstMessage(user).payload.text, /только для админов/);
});

test('/last shows recent rows tagged with their direction', () => {
  const calls = handleUpdate(msg(4242, '/last'), ctx);
  const text = firstMessage(calls).payload.text;
  assert.match(text, /Yandex/);
  assert.match(text, /\[analyst\]/);
  const empty = handleUpdate(msg(777, '/last'), ctx);
  assert.match(firstMessage(empty).payload.text, /нет записей/);
});

test('/whoami, /ping, unknown commands and silent updates', () => {
  assert.match(firstMessage(handleUpdate(msg(4242, '/whoami'), ctx)).payload.text, /4242/);
  assert.match(firstMessage(handleUpdate(msg(4242, '/ping'), ctx)).payload.text, /pong/);
  assert.match(firstMessage(handleUpdate(msg(4242, 'привет'), ctx)).payload.text, /Не понял команду/);
  assert.deepEqual(handleUpdate({ update_id: 3 }, ctx), []);
  assert.deepEqual(handleUpdate({ update_id: 4, message: { chat: { id: 1 }, from: { id: 4242 } } }, ctx), []); // no text
});

test('normalizeCommand strips the @botname suffix; escapeHtml neutralizes entities', () => {
  assert.equal(normalizeCommand('/stats@career_ops_bot tail'), '/stats');
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
});
