import test from 'node:test';
import assert from 'node:assert/strict';
import {
  telegramSettings,
  telegramReadiness,
  shouldNotifyOutcome,
  renderTelegramApplicationMessage,
  sendTelegramMessage,
} from '../autopilot-telegram.mjs';

const profile = {
  autopilot: {
    notifications: {
      telegram: {
        enabled: true,
        outcomes: ['applied', 'captcha'],
      },
    },
  },
};

test('telegram config keeps credentials in env and filters outcomes', () => {
  const settings = telegramSettings(profile, {
    TELEGRAM_BOT_TOKEN: 'secret-token',
    TELEGRAM_CHAT_ID: '12345',
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.token, 'secret-token');
  assert.equal(settings.chatId, '12345');
  assert.equal(shouldNotifyOutcome(settings, 'applied'), true);
  assert.equal(shouldNotifyOutcome(settings, 'failed'), false);
});

test('readiness reports missing secrets without making telegram a blocker', () => {
  const ready = telegramReadiness(profile, {});
  assert.equal(ready.enabled, true);
  assert.equal(ready.ok, false);
  assert.deepEqual(ready.missing.sort(), ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
});

test('application message includes safe operational metadata and escapes HTML', () => {
  const text = renderTelegramApplicationMessage({
    outcome: 'applied',
    company: 'A&B <Labs>',
    title: 'Senior Frontend Engineer',
    profile: 'frontend',
    profile_label: 'Frontend / React',
    stack: ['react', 'typescript'],
    ats: 'Greenhouse',
    resume_variant: 'react',
    source: 'boards.greenhouse.io',
    priority: 91,
    duration_ms: 94000,
    url: 'https://example.com/job/1?a=1&b=2',
  });
  assert.match(text, /Application submitted/);
  assert.match(text, /A&amp;B &lt;Labs&gt;/);
  assert.match(text, /Frontend \/ React/);
  assert.match(text, /1m 34s/);
  assert.match(text, /a=1&amp;b=2/);
});

test('sender posts JSON and never needs response body', async () => {
  let seenUrl = '';
  let seenBody = null;
  await sendTelegramMessage(
    { token: '123:abc', chatId: '99', disableWebPreview: true },
    'hello',
    {
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      },
    },
  );
  assert.equal(seenUrl, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(seenBody.chat_id, '99');
  assert.equal(seenBody.text, 'hello');
  assert.equal(seenBody.parse_mode, 'HTML');
});

test('sender error does not expose the bot token in its message', async () => {
  await assert.rejects(
    () => sendTelegramMessage(
      { token: 'TOP-SECRET', chatId: '99' },
      'hello',
      { fetchImpl: async () => ({ ok: false, status: 429 }) },
    ),
    (err) => {
      assert.match(err.message, /HTTP 429/);
      assert.equal(err.message.includes('TOP-SECRET'), false);
      return true;
    },
  );
});
