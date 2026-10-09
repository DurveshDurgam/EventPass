#!/usr/bin/env node
/**
 * Feeds real bookings through the public API so the organizer's Smart Pricing
 * dashboard has something to react to during a demo.
 *
 *   node scripts/demo-traffic.js --event TechFest --tier "General Admission" --tickets 40
 *
 * Uses the seeded attendee accounts and the normal reserve -> pay flow (no
 * database shortcuts), so every booking is a genuine one.
 */
const BASE = process.env.URL || `http://localhost:${process.env.PORT || 3000}`;
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const EVENT = arg('event', 'TechFest').toLowerCase();
const TIER = arg('tier', 'General Admission').toLowerCase();
const TICKETS = Number(arg('tickets', 40));
const PASSWORD = 'EventPass@2026';
const ATTENDEES = ['ananya.sharma@eventpass.in', 'rahul.iyer@eventpass.in', 'meera.kapoor@eventpass.in'];

async function call(jar, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: jar.cookie || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) jar.cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  const jars = [];
  for (const email of ATTENDEES) {
    const jar = {};
    const r = await call(jar, 'POST', '/api/auth/login', { email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`Login failed for ${email}. Did you re-seed? ${r.data.error || ''}`);
    jars.push(jar);
  }
  const { data } = await call({}, 'GET', '/api/events');
  const event = data.events.find((e) => e.name.toLowerCase().includes(EVENT));
  if (!event) throw new Error(`No event matching "${EVENT}"`);
  const tier = event.ticketTypes.find((t) => t.name.toLowerCase() === TIER);
  if (!tier) throw new Error(`No tier "${TIER}" in ${event.name}. Tiers: ${event.ticketTypes.map((t) => t.name).join(', ')}`);

  let booked = 0;
  let turn = 0;
  while (booked < TICKETS) {
    const qty = Math.min(6, TICKETS - booked);
    const jar = jars[turn % jars.length];
    turn += 1;
    const lock = await call(jar, 'POST', '/api/locks', { eventId: event.id, items: [{ ticketTypeId: tier.id, quantity: qty }] });
    if (lock.status !== 201) { console.log(`Stopped: ${lock.data.error}`); break; }
    const pay = await call(jar, 'POST', '/api/checkout', { lockId: lock.data.lock.id, method: 'upi' });
    if (pay.status !== 201) { console.log(`Stopped: ${pay.data.error}`); break; }
    booked += qty;
    process.stdout.write(`\rBooked ${booked}/${TICKETS} × ${tier.name} for ${event.name}`);
  }
  console.log('\nDone. Refresh the organizer dashboard and pick this event under Smart Pricing.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
