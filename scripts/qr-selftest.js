#!/usr/bin/env node
// Offline checks for the Smart Pass token logic. No server needed: `npm run test:qr`
const assert = require('node:assert/strict');
const qr = require('../server/qr');

const ticket = { public_id: 'TK-1234567', event_id: 3, holder_name: 'Ananya Sharma', secret: 'ab'.repeat(32) };
const ctx = { bookingPublicId: 'EP-7654321', tier: 'General Admission' };
const t0 = 1_800_000_005_000; // 5s into a window
const edge = (Math.floor(t0 / qr.PERIOD_MS) + 1) * qr.PERIOD_MS;
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`  ok  ${name}`); };

const live = qr.encodePayload(ticket, ctx, t0);
const parsed = qr.parsePayload(live);

test('live QR carries buyer, tier and booking claims', () => {
  assert.equal(parsed.name, 'Ananya Sharma');
  assert.equal(parsed.tier, 'General Admission');
  assert.equal(parsed.bookingPublicId, 'EP-7654321');
});
test('accepted inside its own 15s window', () => assert.equal(qr.verifyPayload(ticket, parsed, t0 + 3000).ok, true));
test('screenshot 30s later is expired, not forged', () => assert.equal(qr.verifyPayload(ticket, parsed, t0 + 30_000).reason, 'expired'));
test('in-flight scan across the boundary is tolerated for 2s only', () => {
  assert.equal(qr.verifyPayload(ticket, parsed, edge + 1000).ok, true);
  assert.equal(qr.verifyPayload(ticket, parsed, edge + 5000).ok, false);
});
test('editing any claim breaks the signature', () => {
  const body = Buffer.from(JSON.stringify(['TK-1234567', 'EP-7654321', 3, 'VIP', 'Ananya Sharma', Math.floor(t0 / qr.PERIOD_MS)])).toString('base64url');
  const [prefix, , sig] = live.split('.');
  assert.equal(qr.verifyPayload(ticket, qr.parsePayload(`${prefix}.${body}.${sig}`), t0).reason, 'forged');
});
test("another ticket's secret cannot validate it", () => {
  assert.equal(qr.verifyPayload({ ...ticket, secret: 'cd'.repeat(32) }, parsed, t0).reason, 'forged');
});
test('receipt QR verifies identity but is a different kind', () => {
  const r = qr.verifyPayload(ticket, qr.parsePayload(qr.encodeReceipt(ticket, ctx)), t0 + 999_999);
  assert.deepEqual(r, { ok: true, kind: 'receipt' });
});
test('a receipt cannot be upgraded into a live pass', () => {
  const [, body, sig] = qr.encodeReceipt(ticket, ctx).split('.');
  // (a) just relabel it
  assert.equal(qr.parsePayload(`EP2.${body}.${sig}`), null);
  // (b) bolt a current window onto the claims and reuse the receipt signature
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  const forgedBody = Buffer.from(JSON.stringify([...claims, qr.timeWindow(t0)])).toString('base64url');
  assert.equal(qr.verifyPayload(ticket, qr.parsePayload(`EP2.${forgedBody}.${sig}`), t0).reason, 'forged');
});
test('garbage and oversized input are rejected', () => {
  assert.equal(qr.parsePayload('hello'), null);
  assert.equal(qr.parsePayload('x'.repeat(5000)), null);
});
console.log(`\n${n} checks passed`);
