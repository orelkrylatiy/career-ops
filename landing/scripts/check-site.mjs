import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const read=name=>readFile(resolve(root,name),'utf8');
const [html,css,js]=await Promise.all([read('index.html'),read('styles.css'),read('app.js')]);

const checks=[
  ['one h1',(html.match(/<h1\b/gi)||[]).length===1],
  ['title',/<title>[^<]{20,90}<\/title>/i.test(html)],
  ['meta description',/name="description" content="[^"]{90,300}"/i.test(html)],
  ['telegram hero mockup',/class="phone-shell"/i.test(html)&&/class="tg-chat"/i.test(html)],
  ['telegram-only client interface copy',/ТЕЛЕГРАМ — ЭТО И ЕСТЬ ИНТЕРФЕЙС/i.test(html)],
  ['result-linked pricing',/50%/i.test(html)&&/от оффера/i.test(html)&&/Без предоплаты/i.test(html)],
  ['referral offer',/РЕФЕРАЛЬНАЯ ПРОГРАММА/i.test(html)],
  ['faq',/id="faq"/i.test(html)&&(html.match(/<details/g)||[]).length>=5],
  ['telegram ctas',(html.match(/data-telegram-cta/g)||[]).length>=3],
  ['safe Telegram URL validation',/isSafeTelegramUrl/i.test(js)&&/hostname==='t\.me'/i.test(js)],
  ['reduced motion',/prefers-reduced-motion/i.test(css)],
  ['no fake social proof metrics',!/10\s?000\+|500\+|4\.9\/5|70%/i.test(html)],
  ['no exposed account/channel mechanics',!/\b\d+\s*(?:аккаунт|канал)/i.test(html)],
  ['honest guarantee disclosure',/не гарантирует трудоустройство/i.test(html)]
];
for(const [name,ok] of checks){assert.equal(ok,true,'site check failed: '+name);console.log('✓ '+name)}
