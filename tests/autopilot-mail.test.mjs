import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMailArgs, matchesDomain, decodeMime, extractVerification, findVerification, isVerifiedGmailSender } from '../autopilot-mail.mjs';

test('verification mailbox search requires recent time and a validated domain', () => {
  const now = Math.floor(Date.now()/1000);
  assert.equal(parseMailArgs(['wait','--domain','accounts.example.org','--since',String(now)]).domain,'accounts.example.org');
  assert.throws(() => parseMailArgs(['wait','--domain','bad_host','--since',String(now)]),/invalid domain/);
  assert.throws(() => parseMailArgs(['wait','--domain','example.com','--since','1']),/last 15 minutes/);
  assert.equal(matchesDomain('Recruiter <auth@sub.example.com>','example.com'), true);
  assert.equal(matchesDomain('fake@notexample.com','example.com'), false);
});
test('code extraction prefers labelled OTPs and never offers cross-host confirmation links', () => {
  const body='Ваш код подтверждения: 123456\n https://accounts.example.com/verify?token=private';
  assert.equal(extractVerification(body,'accounts.example.com').code,'123456');
  assert.match(extractVerification(body,'accounts.example.com').link,/verify/);
  assert.equal(extractVerification(body,'attacker.test').link,null);
  assert.equal(extractVerification('just order 123456').code, null);
});
test('Gmail lookup enforces DMARC and sender match, even when search returned a message', async () => {
  const now = Date.now();
  const text = Buffer.from('Your verification code: 246810').toString('base64url');
  const fetchFn = async url => ({
    ok:true, json:async()=>url.includes('/messages?')
      ? { messages:[{id:'1'},{id:'2'}] }
      : url.includes('/messages/1?')
        ? { internalDate:String(now), payload:{ headers:[
            {name:'From',value:'evil@attacker.test'},
            {name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=example.org'}
          ],body:{data:text} } }
        : { internalDate:String(now),payload:{headers:[
            {name:'From',value:'auth@example.org'},
            {name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=example.org'}
          ],body:{data:text} } },
  });
  const found=await findVerification({token:'fake',domain:'example.org',since:Math.floor(now/1000)-2,fetchFn});
  assert.equal(found.code,'246810');
});

test('rejects forged or unaligned Authentication-Results on OTP messages', () => {
  const headers = [
    {name: 'From', value: 'accounts@example.org'},
    {name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=attacker.test'}
  ];
  assert.equal(isVerifiedGmailSender(headers, 'example.org'), false);
  headers[1].value = 'evil-mx.test; dmarc=pass header.from=example.org';
  assert.equal(isVerifiedGmailSender(headers, 'example.org'), false);
  headers[1].value = 'mx.google.com; dmarc=fail header.from=example.org';
  assert.equal(isVerifiedGmailSender(headers, 'example.org'), false);
  headers[1].value = 'mx.google.com; dmarc=pass header.from=example.org';
  assert.equal(isVerifiedGmailSender(headers, 'example.org'), true);
});
