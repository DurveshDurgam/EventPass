#!/usr/bin/env node
/**
 * Capacity-lock stress test.
 *
 * Simulates a rush on the last few tickets of an event and checks the one
 * property that matters: the system never sells or holds more than exists.
 *
 *   node scripts/stress-test.js                       # 1000 users, 10 tickets
 *   node scripts/stress-test.js --users 300 --tickets 6
 *   node scripts/stress-test.js --keep                # leave the test event in the DB
 *
 * Phases
 *   1. All users try to reserve at the same instant.
 *   2. Half of the winners pay, half walk away.
 *   3. If the server's lock is short (start it with EVENTPASS_LOCK_MS=8000),
 *      waits for the abandoned holds to expire and shows them returning to the pool.
 *
 * The server must already be running (npm start). Users are created straight in
 * the database and given signed session cookies, so 1,000 "people" cost nothing.
 */
const { getDb, tx } = require('../server/db');
const { hashPassword, signToken, COOKIE } = require('../server/auth');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const USERS = Number(arg('users', 1000));
const TICKETS = Number(arg('tickets', 10));
const BASE = arg('url', `http://localhost:${process.env.PORT || 3000}`);
const KEEP = process.argv.includes('--keep');
const TAG = 'loadtest.local';
const EVENT_NAME = `Stress Test: last ${TICKETS} tickets`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? green('PASS') : red('FAIL')}  ${label}${detail ? '  ' + detail : ''}`);
}

async function http(method, path, cookie, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    } catch (err) {
      if (attempt === 2) return { status: 0, data: { error: String(err.cause?.code || err.message) } };
      await sleep(50);
    }
  }
}

function cleanup(db) {
  tx((d) => {
    const ev = d.prepare('SELECT id FROM events WHERE name = ?').all(EVENT_NAME).map((r) => r.id);
    for (const id of ev) {
      d.prepare('DELETE FROM scan_attempts WHERE event_id = ?').run(id);
      d.prepare('DELETE FROM check_ins WHERE event_id = ?').run(id);
      d.prepare('DELETE FROM tickets WHERE event_id = ?').run(id);
      d.prepare('DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE event_id = ?)').run(id);
      d.prepare('DELETE FROM booking_items WHERE booking_id IN (SELECT id FROM bookings WHERE event_id = ?)').run(id);
      d.prepare('DELETE FROM bookings WHERE event_id = ?').run(id);
      d.prepare('DELETE FROM ticket_lock_items WHERE lock_id IN (SELECT id FROM ticket_locks WHERE event_id = ?)').run(id);
      d.prepare('DELETE FROM ticket_locks WHERE event_id = ?').run(id);
      d.prepare('DELETE FROM ticket_types WHERE event_id = ?').run(id);
      d.prepare('DELETE FROM events WHERE id = ?').run(id);
    }
    d.prepare(`DELETE FROM users WHERE email LIKE '%@${TAG}'`).run();
  });
}

async function main() {
  const health = await http('GET', '/api/health', '');
  if (health.status !== 200) {
    console.error(`Cannot reach ${BASE}. Start the server first (npm start).`);
    process.exit(2);
  }
  const lockMs = health.data.lockMs;
  const db = getDb();
  cleanup(db);

  const organizer = db.prepare("SELECT id FROM users WHERE role = 'organizer' ORDER BY id LIMIT 1").get();
  const { eventId, typeId, users } = tx((d) => {
    const ev = d.prepare(`
      INSERT INTO events (organizer_id, name, description, category, date, time, venue, address, city, image_key, status)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'published')
    `).run(organizer.id, EVENT_NAME, 'Automated capacity test. Safe to delete.', 'Music', '2026-12-31', '20:00', 'Test Hall', 'Test Road', 'Mumbai', 'music');
    const eventId = Number(ev.lastInsertRowid);
    const tt = d.prepare('INSERT INTO ticket_types (event_id, name, price_paise, capacity, sold, sort_order) VALUES (?,?,?,?,0,0)')
      .run(eventId, 'Last Seats', 99900, TICKETS);
    const hash = hashPassword('not-used');
    const ins = d.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?, 'customer')");
    const users = [];
    for (let i = 1; i <= USERS; i += 1) {
      const info = ins.run(`rush${i}@${TAG}`, hash, `Rush User ${i}`);
      users.push({ id: Number(info.lastInsertRowid), want: 1 + (i % 2) });
    }
    return { eventId, typeId: Number(tt.lastInsertRowid), users };
  });
  const now = Math.floor(Date.now() / 1000);
  for (const u of users) {
    u.cookie = `${COOKIE}=${signToken({ sub: u.id, role: 'customer', iat: now, exp: now + 3600 })}`;
  }
  const availability = async () => {
    const r = await http('GET', `/api/events/${eventId}`, '');
    const t = r.data.event.ticketTypes[0];
    return { available: t.available, sold: t.sold, capacity: t.capacity };
  };

  console.log(`\nEventPass capacity-lock stress test`);
  console.log(`  ${USERS} users, ${TICKETS} tickets, each user wants 1 or 2. Server lock = ${Math.round(lockMs / 1000)}s\n`);

  // ---- Phase 1: simultaneous reservation attempts ----
  console.log('Phase 1: everyone clicks "Book" at the same moment');
  const t0 = Date.now();
  const results = await Promise.all(users.map((u) =>
    http('POST', '/api/locks', u.cookie, { eventId, items: [{ ticketTypeId: typeId, quantity: u.want }] }).then((r) => ({ u, r }))));
  const ms = Date.now() - t0;
  const winners = results.filter((x) => x.r.status === 201);
  const soldOut = results.filter((x) => x.r.status === 409);
  const other = results.filter((x) => ![201, 409].includes(x.r.status));
  const held = winners.reduce((n, x) => n + x.u.want, 0);
  console.log(`  ${USERS} requests in ${ms}ms: ${winners.length} reserved (${held} seats), ${soldOut.length} told "sold out", ${other.length} other\n`);
  check('no more seats held than exist', held <= TICKETS, `held ${held} / capacity ${TICKETS}`);
  check('every request got a clean answer (201 or 409)', other.length === 0, other.length ? JSON.stringify(other[0].r) : '');
  const a1 = await availability();
  check('public availability reads zero while seats are held', a1.available === Math.max(0, TICKETS - held), `${a1.available} available`);

  // ---- Phase 2: half pay, half abandon ----
  console.log('\nPhase 2: half of the winners pay, half walk away');
  const payers = winners.filter((_, i) => i % 2 === 0);
  const walkers = winners.filter((_, i) => i % 2 === 1);
  const paid = await Promise.all(payers.map((x) => http('POST', '/api/checkout', x.u.cookie, { lockId: x.r.data.lock.id, method: 'upi' })));
  const paidOk = paid.filter((r) => r.status === 201);
  const seatsPaid = payers.reduce((n, x, i) => n + (paid[i].status === 201 ? x.u.want : 0), 0);
  const seatsWalked = walkers.reduce((n, x) => n + x.u.want, 0);
  console.log(`  ${paidOk.length} paid (${seatsPaid} seats), ${walkers.length} abandoned (${seatsWalked} seats still held)`);
  const row = db.prepare('SELECT sold, capacity FROM ticket_types WHERE id = ?').get(typeId);
  const issued = db.prepare('SELECT COUNT(*) AS c FROM tickets WHERE event_id = ?').get(eventId).c;
  check('sold never exceeds capacity', row.sold <= row.capacity, `sold ${row.sold} / ${row.capacity}`);
  check('tickets issued match seats paid for', issued === seatsPaid, `${issued} tickets`);

  // ---- Phase 3: abandoned holds expire and return to the pool ----
  if (seatsWalked > 0 && lockMs <= 60_000) {
    console.log(`\nPhase 3: waiting ${Math.round(lockMs / 1000)}s for abandoned holds to expire`);
    await sleep(lockMs + 1500);
    const a3 = await availability();
    check('abandoned seats returned to the pool automatically', a3.available === TICKETS - seatsPaid, `${a3.available} available`);
    const retry = await Promise.all(soldOut.map((x) => http('POST', '/api/locks', x.u.cookie, { eventId, items: [{ ticketTypeId: typeId, quantity: 1 }] })));
    const regained = retry.filter((r) => r.status === 201).length;
    check('previously turned-away users can now get the released seats', regained === Math.min(a3.available, soldOut.length), `${regained} new reservations`);
  } else if (seatsWalked > 0) {
    console.log(`\nPhase 3 skipped: lock is ${Math.round(lockMs / 1000)}s. Restart the server with EVENTPASS_LOCK_MS=8000 to watch holds expire.`);
  }

  const finalRow = db.prepare('SELECT sold, capacity FROM ticket_types WHERE id = ?').get(typeId);
  const activeLocked = db.prepare(`
    SELECT COALESCE(SUM(li.quantity),0) AS q FROM ticket_lock_items li JOIN ticket_locks l ON l.id = li.lock_id
    WHERE li.ticket_type_id = ? AND l.status = 'active' AND l.expires_at > ?
  `).get(typeId, Date.now()).q;
  console.log('\nFinal invariants');
  check('sold + live holds <= capacity', finalRow.sold + activeLocked <= finalRow.capacity, `${finalRow.sold} sold + ${activeLocked} held <= ${finalRow.capacity}`);

  if (!KEEP) cleanup(db);
  console.log(failures ? red(`\n${failures} check(s) failed\n`) : green('\nAll checks passed: no overbooking.\n'));
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
