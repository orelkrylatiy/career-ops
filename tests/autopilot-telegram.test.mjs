import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTelegramApplication,
  sendTelegramMessage,
  telegramConfig,
  telegramPreflight,
} from '../autopilot-telegram.mjs';

test('telegram config uses env indirection and stays opt-in', () => {
  const profile = {
    autopilot: {
      notifications: {
        telegram: {
          enabled: true,
          token_env: 'BOT_TOKEN_X',
          chat_id_env: 'CHAT_X',
          outcomes: ['applied'],
        },
      },
    },
  };
  const cfg = telegramConfig(profile, { BOT_TOKEN_X: 'token', CHAT_X: '42' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.token, 'token');
  assert.equal(cfg.chatId, '42');
  assert.deepEqual(cfg.outcomes, ['applied']);
  assert.deepEqual(telegramPreflight(profile, {} ).warnings.sort(), [
    'BOT_TOKEN_X is missing',
    'CHAT_X is missing',
  ]);
});

test('application message includes profile, resume and operational counters', () => {
  const text = formatTelegramApplication({
    outcome: 'applied',
    job: {
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      location: 'Remote',
      url: 'https://jobs.example/1',
      priority: 88,
    },
    metadata: {
      ats: 'greenhouse',
      resumeVariant: 'react',
      profileKey: 'frontend',
      durationMs: 91000,
    },
    profile: { label: 'Frontend', stack: ['react', 'typescript'] },
  }, { today: 12, queue: 34, profileApplied: 7 });

  assert.match(text, /Application submitted/);
  assert.match(text, /Profile: Frontend/);
  assert.match(text, /Stack: react, typescript/);
  assert.match(text, /Resume: react/);
  assert.match(text, /today 12/);
  assert.match(text, /frontend applied 7/);
});

test('sendTelegramMessage posts JSON to Bot API', async () => {
  let seen = null;
  const result = await sendTelegramMessage({
    token: 'abc',
    chatId: '123',
    text: 'hello',
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 9 } }),
      };
    },
  });
  assert.equal(result.message_id, 9);
  assert.equal(seen.url, 'https://api.telegram.org/botabc/sendMessage');
  assert.equal(JSON.parse(seen.opts.body).chat_id, '123');
});
