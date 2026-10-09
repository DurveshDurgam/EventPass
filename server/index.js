const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  getDb, tx, expireLocks, availableForType, eventCapacity, lockSnapshot, plain,
} = require('./db');
const {
  hashPassword, verifyPassword, issueSession, clearSession, publicUser,
  authRequired, optionalAuth, requireRole,
} = require('./auth');
const {
  encodePayload, encodeReceipt, remainingMs, verifyPayload, parsePayload, newTicketSecret, newPublicId, paymentRef, PERIOD_MS,
} = require('./qr');
const { insightsForEvent, MAX_UP, MAX_DOWN } = require('./pricing');

const PORT = Number(process.env.PORT || 3000);
const LOCK_MS = Number(process.env.EVENTPASS_LOCK_MS) > 0 ? Number(process.env.EVENTPASS_LOCK_MS) : 5 * 60 * 1000;
const MAX_QTY = 6;
const FEE_RATE = 0.025;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, '..', 'public')));

function sendError(res, status, error) {
  return res.status(status).json({ error });
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

function isEventDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return false;
  const parsed = new Date(`${date}T${time}:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date &&
    parsed.toISOString().slice(11, 16) === time;
}

function formatEvent(row, types) {
  const capacity = types.reduce((s, t) => s + t.capacity, 0);
  const sold = types.reduce((s, t) => s + t.sold, 0);
  const available = types.reduce((s, t) => s + t.available, 0);
  const from = types.length ? Math.min(...types.map((t) => t.price_paise)) : 0;
  const low = available > 0 && available <= 8;
  return {
    ...plain(row),
    ticketTypes: types,
    totalCapacity: capacity,
    ticketsSold: sold,
    ticketsRemaining: available,
    fromPricePaise: from,
    availability: available <= 0 ? 'sold_out' : low ? 'low' : 'open',
  };
}

function loadEventBundle(eventId) {
  const db = getDb();
  expireLocks(db);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return null;
  const organizer = db.prepare('SELECT id, name FROM users WHERE id = ?').get(event.organizer_id);
  const types = eventCapacity(db, event.id);
  return { event: formatEvent(event, types), organizer: { id: organizer.id, name: organizer.name } };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, product: 'EventPass', lockMs: LOCK_MS, qrPeriodMs: PERIOD_MS }));

app.get('/api/auth/me', optionalAuth, (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, phone, role } = req.body || {};
  const chosen = role === 'organizer' ? 'organizer' : 'customer';
  if (!String(name || '').trim() || String(name).trim().length < 2) {
    return sendError(res, 400, 'Enter your full name.');
  }
  if (!isEmail(email)) return sendError(res, 400, 'Enter a valid email, like name@mail.com');
  if (!password || String(password).length < 8) return sendError(res, 400, 'Password must be at least 8 characters.');
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).trim());
  if (exists) return sendError(res, 409, 'An account with this email already exists.');
  const info = db.prepare('INSERT INTO users (email, password_hash, name, phone, role) VALUES (?,?,?,?,?)')
    .run(String(email).trim(), hashPassword(password), String(name).trim(), String(phone || '').trim(), chosen);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  issueSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password, role } = req.body || {};
  if (!isEmail(email) || !password) return sendError(res, 400, 'Enter your email and password.');
  const user = getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return sendError(res, 401, 'Those details do not match an EventPass account.');
  }
  if (role === 'organizer' && user.role === 'customer') {
    return sendError(res, 403, 'This account is an attendee account. Switch to Attendee to sign in.');
  }
  if (role === 'customer' && user.role === 'organizer') {
    return sendError(res, 403, 'This is an organizer account. Switch to Organizer to sign in.');
  }
  issueSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.put('/api/auth/profile', authRequired, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const phone = String((req.body || {}).phone || '').trim();
  if (name.length < 2) return sendError(res, 400, 'Enter your full name.');
  getDb().prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

app.get('/api/events', optionalAuth, (req, res) => {
  const db = getDb();
  expireLocks(db);
  const q = String(req.query.q || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim();
  const weekend = req.query.weekend === '1';
  let rows = db.prepare(`
    SELECT * FROM events WHERE status = 'published' ORDER BY date ASC, time ASC
  `).all();
  if (category && category !== 'All') rows = rows.filter((e) => e.category === category);
  if (q) {
    rows = rows.filter((e) => `${e.name} ${e.venue} ${e.city} ${e.description}`.toLowerCase().includes(q));
  }
  if (weekend) {
    rows = rows.filter((e) => {
      const d = new Date(`${e.date}T12:00:00`).getDay();
      return d === 0 || d === 6;
    });
  }
  const events = rows.map((row) => formatEvent(row, eventCapacity(db, row.id)));
  res.json({ events });
});

app.get('/api/events/:id', optionalAuth, (req, res) => {
  const bundle = loadEventBundle(Number(req.params.id));
  if (!bundle || bundle.event.status === 'cancelled') return sendError(res, 404, 'Event not found.');
  if (bundle.event.status !== 'published' && (!req.user || (req.user.role === 'organizer' && req.user.id !== bundle.event.organizer_id))) {
    return sendError(res, 404, 'Event not found.');
  }
  let lock = null;
  if (req.user) {
    expireLocks();
    const row = getDb().prepare(`
      SELECT id FROM ticket_locks
      WHERE user_id = ? AND event_id = ? AND status = 'active' AND expires_at > ?
      ORDER BY id DESC LIMIT 1
    `).get(req.user.id, bundle.event.id, Date.now());
    if (row) lock = lockSnapshot(getDb(), row.id);
  }
  res.json({ ...bundle, lock, lockMs: LOCK_MS });
});

app.get('/api/locks/active', authRequired, (req, res) => {
  expireLocks();
  const row = getDb().prepare(`
    SELECT id FROM ticket_locks
    WHERE user_id = ? AND status = 'active' AND expires_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(req.user.id, Date.now());
  res.json({ lock: row ? lockSnapshot(getDb(), row.id) : null, lockMs: LOCK_MS });
});

app.post('/api/locks', authRequired, requireRole('customer', 'admin'), (req, res) => {
  const eventId = Number((req.body || {}).eventId);
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  // Merge duplicate ticket types before inventory checks so each ticket is
  // reserved exactly once, even for a hand-crafted API request.
  const quantities = new Map();
  for (const item of items) {
    const ticketTypeId = Number(item?.ticketTypeId);
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(ticketTypeId) || ticketTypeId < 1 ||
        !Number.isSafeInteger(quantity) || quantity < 1) {
      return sendError(res, 400, 'Ticket types and quantities must be valid whole numbers.');
    }
    quantities.set(ticketTypeId, (quantities.get(ticketTypeId) || 0) + quantity);
  }
  const cleaned = [...quantities].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
  const totalQty = cleaned.reduce((s, i) => s + i.quantity, 0);
  if (!eventId || !cleaned.length) return sendError(res, 400, 'Select at least one ticket.');
  if (totalQty > MAX_QTY) return sendError(res, 400, `You can book at most ${MAX_QTY} tickets at a time.`);

  try {
    const lock = tx((database) => {
      expireLocks(database);
      const event = database.prepare("SELECT * FROM events WHERE id = ? AND status = 'published'").get(eventId);
      if (!event) throw Object.assign(new Error('Event is not open for booking.'), { status: 404 });
      database.prepare(`
        UPDATE ticket_locks SET status = 'released'
        WHERE user_id = ? AND event_id = ? AND status = 'active'
      `).run(req.user.id, eventId);
      for (const item of cleaned) {
        const type = database.prepare('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?').get(item.ticketTypeId, eventId);
        if (!type) throw Object.assign(new Error('Ticket type is not valid for this event.'), { status: 400 });
        const avail = availableForType(database, type);
        if (item.quantity > avail) {
          throw Object.assign(new Error(`Only ${avail} ${type.name} ticket${avail === 1 ? '' : 's'} left.`), { status: 409 });
        }
      }
      const info = database.prepare(`
        INSERT INTO ticket_locks (user_id, event_id, expires_at, status) VALUES (?,?,?, 'active')
      `).run(req.user.id, eventId, Date.now() + LOCK_MS);
      const lockId = Number(info.lastInsertRowid);
      for (const item of cleaned) {
        const price = database.prepare('SELECT price_paise FROM ticket_types WHERE id = ?').get(item.ticketTypeId).price_paise;
        database.prepare('INSERT INTO ticket_lock_items (lock_id, ticket_type_id, quantity, unit_price_paise) VALUES (?,?,?,?)')
          .run(lockId, item.ticketTypeId, item.quantity, price);
      }
      return lockSnapshot(database, lockId);
    });
    res.status(201).json({ lock, lockMs: LOCK_MS, message: 'Tickets reserved for you' });
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
});

app.get('/api/locks/:id', authRequired, (req, res) => {
  expireLocks();
  const lock = lockSnapshot(getDb(), Number(req.params.id));
  if (!lock || lock.user_id !== req.user.id) return sendError(res, 404, 'Reservation not found.');
  res.json({ lock });
});

app.delete('/api/locks/:id', authRequired, (req, res) => {
  expireLocks();
  const n = getDb().prepare(`
    UPDATE ticket_locks SET status = 'released' WHERE id = ? AND user_id = ? AND status = 'active'
  `).run(Number(req.params.id), req.user.id).changes;
  res.json({ ok: true, released: n > 0 });
});

app.post('/api/checkout', authRequired, requireRole('customer', 'admin'), (req, res) => {
  const lockId = Number((req.body || {}).lockId);
  const method = String((req.body || {}).method || 'card');
  if (!['card', 'upi'].includes(method)) return sendError(res, 400, 'Choose a payment method.');
  try {
    const result = tx((database) => {
      expireLocks(database);
      const lock = database.prepare('SELECT * FROM ticket_locks WHERE id = ?').get(lockId);
      if (!lock || lock.user_id !== req.user.id) throw Object.assign(new Error('Reservation not found.'), { status: 404 });
      if (lock.status !== 'active' || lock.expires_at <= Date.now()) {
        throw Object.assign(new Error('Your reservation expired. Tickets were released.'), { status: 409 });
      }
      const items = database.prepare(`
        SELECT li.id, li.quantity, tt.name, tt.capacity, tt.sold, tt.id AS ticket_type_id,
               COALESCE(li.unit_price_paise, tt.price_paise) AS price_paise
        FROM ticket_lock_items li JOIN ticket_types tt ON tt.id = li.ticket_type_id
        WHERE li.lock_id = ?
      `).all(lock.id);
      for (const item of items) {
        const avail = item.capacity - item.sold;
        if (item.quantity > avail) {
          throw Object.assign(new Error(`Not enough ${item.name} tickets left to complete payment.`), { status: 409 });
        }
      }
      const subtotal = items.reduce((s, i) => s + i.quantity * i.price_paise, 0);
      const fee = Math.round(subtotal * FEE_RATE);
      const publicId = newPublicId('EP');
      const b = database.prepare(`
        INSERT INTO bookings (public_id, user_id, event_id, lock_id, status, amount_paise, fee_paise)
        VALUES (?,?,?,?, 'confirmed', ?, ?)
      `).run(publicId, req.user.id, lock.event_id, lock.id, subtotal + fee, fee);
      const bookingId = Number(b.lastInsertRowid);
      const tickets = [];
      for (const item of items) {
        database.prepare('INSERT INTO booking_items (booking_id, ticket_type_id, quantity, unit_price_paise) VALUES (?,?,?,?)')
          .run(bookingId, item.ticket_type_id, item.quantity, item.price_paise);
        const upd = database.prepare(`
          UPDATE ticket_types SET sold = sold + ?
          WHERE id = ? AND sold + ? <= capacity
        `).run(item.quantity, item.ticket_type_id, item.quantity);
        if (upd.changes !== 1) {
          throw Object.assign(new Error('Those tickets sold while you were paying. No charge was captured.'), { status: 409 });
        }
        for (let i = 0; i < item.quantity; i += 1) {
          const t = database.prepare(`
            INSERT INTO tickets (public_id, booking_id, ticket_type_id, event_id, user_id, holder_name, secret, status)
            VALUES (?,?,?,?,?,?,?, 'confirmed')
          `).run(newPublicId('TK'), bookingId, item.ticket_type_id, lock.event_id, req.user.id, req.user.name, newTicketSecret());
          tickets.push(Number(t.lastInsertRowid));
        }
      }
      database.prepare(`
        INSERT INTO payments (booking_id, amount_paise, method, status, reference) VALUES (?,?,?, 'captured', ?)
      `).run(bookingId, subtotal + fee, method, paymentRef());
      database.prepare(`UPDATE ticket_locks SET status = 'converted' WHERE id = ?`).run(lock.id);
      return { bookingId, publicId, ticketIds: tickets };
    });
    const booking = bookingPayload(result.bookingId, req.user);
    res.status(201).json({ booking, message: 'Booking confirmed' });
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
});

function bookingPayload(bookingId, user) {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return null;
  if (user.role === 'customer' && booking.user_id !== user.id) return null;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(booking.event_id);
  const items = db.prepare(`
    SELECT bi.*, tt.name FROM booking_items bi JOIN ticket_types tt ON tt.id = bi.ticket_type_id
    WHERE bi.booking_id = ?
  `).all(booking.id).map(plain);
  const tickets = db.prepare(`
    SELECT t.id, t.public_id, t.status, t.holder_name, tt.name AS ticket_type
    FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
    WHERE t.booking_id = ?
  `).all(booking.id).map(plain);
  const payment = plain(db.prepare('SELECT method, status, reference, amount_paise FROM payments WHERE booking_id = ?').get(booking.id));
  return { ...plain(booking), event: plain(event), items, tickets, payment };
}

app.get('/api/bookings', authRequired, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT b.* FROM bookings b WHERE b.user_id = ? ORDER BY b.created_at DESC
  `).all(req.user.id);
  const bookings = rows.map((b) => bookingPayload(b.id, req.user));
  res.json({ bookings });
});

app.get('/api/bookings/:id', authRequired, (req, res) => {
  const booking = bookingPayload(Number(req.params.id), req.user);
  if (!booking || (req.user.role === 'customer' && booking.user_id !== req.user.id)) {
    return sendError(res, 404, 'Booking not found.');
  }
  res.json({ booking });
});

app.post('/api/bookings/:id/cancel', authRequired, (req, res) => {
  try {
    const booking = tx((database) => {
      const row = database.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
      if (!row || row.user_id !== req.user.id) throw Object.assign(new Error('Booking not found.'), { status: 404 });
      if (row.status === 'cancelled') throw Object.assign(new Error('This booking is already cancelled.'), { status: 400 });
      const used = database.prepare("SELECT COUNT(*) AS c FROM tickets WHERE booking_id = ? AND status = 'used'").get(row.id).c;
      if (used) throw Object.assign(new Error('A ticket from this booking has already been used.'), { status: 400 });
      const event = database.prepare('SELECT * FROM events WHERE id = ?').get(row.event_id);
      if (new Date(`${event.date}T${event.time}:00`).getTime() < Date.now()) {
        throw Object.assign(new Error('This event has already started.'), { status: 400 });
      }
      database.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
      database.prepare("UPDATE tickets SET status = 'cancelled' WHERE booking_id = ?").run(row.id);
      const items = database.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(row.id);
      for (const item of items) {
        database.prepare('UPDATE ticket_types SET sold = MAX(sold - ?, 0) WHERE id = ?').run(item.quantity, item.ticket_type_id);
      }
      return row.id;
    });
    res.json({ booking: bookingPayload(booking, req.user) });
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
});

function canSeeTicket(db, ticket, user) {
  if (user.role === 'customer') return ticket.user_id === user.id;
  if (user.role === 'organizer') {
    return db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(ticket.event_id)?.organizer_id === user.id;
  }
  return true;
}

function loadTicket(db, ticketId) {
  return db.prepare(`
    SELECT t.*, tt.name AS ticket_type, b.public_id AS booking_public_id, b.status AS booking_status
    FROM tickets t
    JOIN ticket_types tt ON tt.id = t.ticket_type_id
    JOIN bookings b ON b.id = t.booking_id
    WHERE t.id = ?
  `).get(ticketId);
}

function ticketPayload(ticketId, user) {
  const db = getDb();
  const ticket = loadTicket(db, ticketId);
  if (!ticket || !canSeeTicket(db, ticket, user)) return null;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(ticket.event_id);
  const holder = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(ticket.user_id);
  // Other tickets in the same booking, so a buyer of several can flip between passes.
  const siblings = db.prepare(`
    SELECT t.id, t.public_id, t.status, tt.name AS ticket_type
    FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
    WHERE t.booking_id = ? ORDER BY t.id
  `).all(ticket.booking_id).map(plain);
  const { secret, ...safe } = plain(ticket);
  return { ticket: safe, event: plain(event), holder: plain(holder), siblings };
}

app.get('/api/tickets/:id', authRequired, (req, res) => {
  const payload = ticketPayload(Number(req.params.id), req.user);
  if (!payload) return sendError(res, 404, 'Ticket not found.');
  res.json(payload);
});

// Rolling pass: the QR content is only valid for the current 15-second window.
app.get('/api/tickets/:id/qr', authRequired, (req, res) => {
  const db = getDb();
  const ticket = loadTicket(db, Number(req.params.id));
  if (!ticket || !canSeeTicket(db, ticket, req.user)) return sendError(res, 404, 'Ticket not found.');
  res.set('Cache-Control', 'no-store');
  if (ticket.status !== 'confirmed') {
    return res.json({ active: false, status: ticket.status, payload: null, remainingMs: 0, periodMs: PERIOD_MS, serverTime: Date.now() });
  }
  res.json({
    active: true,
    status: ticket.status,
    payload: encodePayload(ticket, { bookingPublicId: ticket.booking_public_id, tier: ticket.ticket_type }),
    remainingMs: remainingMs(),
    periodMs: PERIOD_MS,
    serverTime: Date.now(),
  });
});

// Static "receipt" QR for the downloadable / printed pass. Identifies the buyer
// but is never accepted for entry.
app.get('/api/tickets/:id/receipt', authRequired, (req, res) => {
  const db = getDb();
  const ticket = loadTicket(db, Number(req.params.id));
  if (!ticket || !canSeeTicket(db, ticket, req.user)) return sendError(res, 404, 'Ticket not found.');
  res.set('Cache-Control', 'no-store');
  res.json({ payload: encodeReceipt(ticket, { bookingPublicId: ticket.booking_public_id, tier: ticket.ticket_type }) });
});

function salesForEvent(db, eventId) {
  return db.prepare(`
    SELECT b.created_at, bi.ticket_type_id, bi.quantity, bi.unit_price_paise
    FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id
    WHERE b.event_id = ? AND b.status = 'confirmed'
  `).all(eventId);
}

function lastPriceChanges(db, eventId) {
  const rows = db.prepare('SELECT ticket_type_id, MAX(created_at) AS at FROM pricing_changes WHERE event_id = ? GROUP BY ticket_type_id').all(eventId);
  return Object.fromEntries(rows.map((r) => [r.ticket_type_id, r.at]));
}

function pricingHistory(db, eventId, limit = 6) {
  return db.prepare(`
    SELECT pc.id, pc.old_price_paise, pc.new_price_paise, pc.source, pc.created_at, tt.name AS ticket_type, u.name AS changed_by
    FROM pricing_changes pc
    JOIN ticket_types tt ON tt.id = pc.ticket_type_id
    JOIN users u ON u.id = pc.changed_by
    WHERE pc.event_id = ? ORDER BY pc.created_at DESC, pc.id DESC LIMIT ?
  `).all(eventId, limit).map(plain);
}

function eventInsights(db, event) {
  expireLocks(db);
  const types = db.prepare('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, id').all(event.id);
  return insightsForEvent(event, types, salesForEvent(db, event.id), { lastChangeByType: lastPriceChanges(db, event.id) });
}

function scanStats(db, eventId) {
  const checkedIn = db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE event_id = ? AND status = 'used'").get(eventId).c;
  const total = db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE event_id = ? AND status IN ('confirmed','used')").get(eventId).c;
  const blocked = db.prepare(`
    SELECT COUNT(*) AS c FROM scan_attempts
    WHERE event_id = ? AND result IN ('expired','invalid','used','wrong_event','cancelled')
  `).get(eventId).c;
  return { checkedIn, total, blocked };
}

function assertOrgEvent(user, eventId) {
  const event = getDb().prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return { error: 'Event not found.', status: 404 };
  if (user.role !== 'admin' && event.organizer_id !== user.id) {
    return { error: 'You cannot access another organizer’s event.', status: 403 };
  }
  return { event };
}

function parseTicketTypes(input, existingSoldMap = {}) {
  if (!Array.isArray(input) || !input.length) throw Object.assign(new Error('Add at least one ticket type.'), { status: 400 });
  const types = input.map((t, i) => ({
    id: t.id ? Number(t.id) : null,
    name: String(t.name || '').trim(),
    price_paise: Math.round(Number(t.price) * 100) || Math.round(Number(t.price_paise) || 0),
    capacity: Number(t.capacity),
    sort_order: i,
  }));
  for (const t of types) {
    if (!t.name) throw Object.assign(new Error('Each ticket type needs a name.'), { status: 400 });
    if (!(t.price_paise >= 0)) throw Object.assign(new Error('Enter a valid ticket price.'), { status: 400 });
    if (!Number.isInteger(t.capacity) || t.capacity < 1) throw Object.assign(new Error('Capacity must be at least 1.'), { status: 400 });
    const sold = t.id ? (existingSoldMap[t.id] || 0) : 0;
    if (t.capacity < sold) throw Object.assign(new Error(`Capacity for ${t.name} cannot be below tickets already sold (${sold}).`), { status: 400 });
  }
  return types;
}

app.get('/api/organizer/dashboard', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  const db = getDb();
  expireLocks(db);
  const events = req.user.role === 'admin'
    ? db.prepare('SELECT * FROM events ORDER BY date').all()
    : db.prepare('SELECT * FROM events WHERE organizer_id = ? ORDER BY date').all(req.user.id);
  const ids = events.map((e) => e.id);
  let totalBookings = 0;
  let ticketsSold = 0;
  let ticketsRemaining = 0;
  let revenue = 0;
  let checkins = 0;
  const eventStats = events.map((e) => {
    const types = eventCapacity(db, e.id);
    const cap = types.reduce((s, t) => s + t.capacity, 0);
    const sold = types.reduce((s, t) => s + t.sold, 0);
    const rem = types.reduce((s, t) => s + t.available, 0);
    const bookCount = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE event_id = ? AND status = 'confirmed'").get(e.id).c;
    const rev = db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS s FROM bookings WHERE event_id = ? AND status = 'confirmed'").get(e.id).s;
    const used = db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE event_id = ? AND status = 'used'").get(e.id).c;
    totalBookings += bookCount;
    ticketsSold += sold;
    ticketsRemaining += rem;
    revenue += rev;
    checkins += used;
    return {
      ...plain(e),
      capacity: cap,
      sold,
      remaining: rem,
      utilization: cap ? sold / cap : 0,
      bookings: bookCount,
      revenuePaise: rev,
      checkins: used,
      ticketTypes: types,
    };
  });
  const recent = ids.length
    ? db.prepare(`
        SELECT b.public_id, b.amount_paise, b.created_at, b.status, e.name AS event_name, u.name AS buyer
        FROM bookings b
        JOIN events e ON e.id = b.event_id
        JOIN users u ON u.id = b.user_id
        WHERE b.event_id IN (${ids.map(() => '?').join(',')})
        ORDER BY b.created_at DESC LIMIT 8
      `).all(...ids).map(plain)
    : [];
  const nowMs = Date.now();
  const upcoming = eventStats.filter((e) => e.status === 'published'
    && new Date(`${e.date}T${e.time}:00+05:30`).getTime() > nowMs);
  // Insight for every live event so the organizer can switch, defaulting to
  // whichever one has the strongest demand right now.
  const insightByEvent = new Map(upcoming.map((e) => [e.id, eventInsights(db, e)]));
  const insightEvents = upcoming
    .map((e) => ({ id: e.id, name: e.name, demand: insightByEvent.get(e.id).demand, demandScore: insightByEvent.get(e.id).demandScore }))
    .sort((x, y) => y.demandScore - x.demandScore);
  const wanted = Number(req.query.event);
  const featured = insightByEvent.has(wanted) ? wanted : (insightEvents[0] ? insightEvents[0].id : null);
  const insights = featured ? insightByEvent.get(featured) : null;
  res.json({
    stats: {
      events: events.length,
      bookings: totalBookings,
      ticketsSold,
      ticketsRemaining,
      revenuePaise: revenue,
      checkins,
      utilization: ticketsSold + ticketsRemaining ? ticketsSold / (ticketsSold + ticketsRemaining) : 0,
    },
    events: eventStats,
    recentBookings: recent,
    insights,
    insightEvents,
    pricingHistory: featured ? pricingHistory(db, featured) : [],
    featuredEventId: featured,
    serverTime: nowMs,
  });
});

app.get('/api/organizer/events', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  const db = getDb();
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT * FROM events ORDER BY date').all()
    : db.prepare('SELECT * FROM events WHERE organizer_id = ? ORDER BY date').all(req.user.id);
  res.json({ events: rows.map((r) => formatEvent(r, eventCapacity(db, r.id))) });
});

app.get('/api/organizer/events/:id', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  const found = assertOrgEvent(req.user, Number(req.params.id));
  if (found.error) return sendError(res, found.status, found.error);
  const db = getDb();
  const types = eventCapacity(db, found.event.id);
  const bookings = db.prepare(`
    SELECT b.*, u.name AS buyer, u.email AS buyer_email,
      (SELECT COALESCE(SUM(quantity),0) FROM booking_items WHERE booking_id = b.id) AS quantity
    FROM bookings b JOIN users u ON u.id = b.user_id
    WHERE b.event_id = ? ORDER BY b.created_at DESC
  `).all(found.event.id).map(plain);
  const checkins = db.prepare(`
    SELECT c.*, t.public_id AS ticket_public_id, t.holder_name, tt.name AS ticket_type
    FROM check_ins c
    JOIN tickets t ON t.id = c.ticket_id
    JOIN ticket_types tt ON tt.id = t.ticket_type_id
    WHERE c.event_id = ? ORDER BY c.scanned_at DESC LIMIT 40
  `).all(found.event.id).map(plain);
  res.json({
    event: formatEvent(found.event, types),
    bookings,
    checkins,
    insights: eventInsights(db, found.event),
    pricingHistory: pricingHistory(db, found.event.id),
    scan: scanStats(db, found.event.id),
  });
});

// Apply one or more Smart Pricing suggestions (or any organizer-chosen price).
// New price only affects future reservations: held carts and past bookings keep theirs.
app.post('/api/organizer/events/:id/pricing/apply', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  const found = assertOrgEvent(req.user, Number(req.params.id));
  if (found.error) return sendError(res, found.status, found.error);
  const body = req.body || {};
  const list = Array.isArray(body.changes) ? body.changes : [{ ticketTypeId: body.ticketTypeId, pricePaise: body.pricePaise }];
  if (!list.length || list.length > 12) return sendError(res, 400, 'Choose at least one price to apply.');
  try {
    tx((database) => {
      for (const c of list) {
        const ticketTypeId = Number(c.ticketTypeId);
        const pricePaise = Number(c.pricePaise);
        if (!Number.isSafeInteger(ticketTypeId) || !Number.isSafeInteger(pricePaise) || pricePaise < 100) {
          throw Object.assign(new Error('Enter a valid price.'), { status: 400 });
        }
        const type = database.prepare('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?').get(ticketTypeId, found.event.id);
        if (!type) throw Object.assign(new Error('Ticket type is not part of this event.'), { status: 400 });
        if (type.price_paise === pricePaise) continue;
        const ratio = pricePaise / type.price_paise;
        // Guard rail: one step can't move a price by more than the model would ever suggest, plus slack for rounding.
        if (ratio > 1 + MAX_UP + 0.05 || ratio < 1 - MAX_DOWN - 0.05) {
          throw Object.assign(new Error(`${type.name}: a single change can move the price by at most +${Math.round(MAX_UP * 100)}% / -${Math.round(MAX_DOWN * 100)}%.`), { status: 400 });
        }
        database.prepare('UPDATE ticket_types SET price_paise = ? WHERE id = ?').run(pricePaise, type.id);
        database.prepare(`
          INSERT INTO pricing_changes (event_id, ticket_type_id, old_price_paise, new_price_paise, source, changed_by, created_at)
          VALUES (?,?,?,?,?,?,?)
        `).run(found.event.id, type.id, type.price_paise, pricePaise, body.source === 'manual' ? 'manual' : 'smart_pricing', req.user.id, Date.now());
      }
    });
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const db = getDb();
  res.json({ insights: eventInsights(db, found.event), pricingHistory: pricingHistory(db, found.event.id), event: loadEventBundle(found.event.id).event });
});

app.post('/api/organizer/events', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();
    const category = String(body.category || 'Workshops').trim();
    const date = String(body.date || '').trim();
    const time = String(body.time || '').trim();
    const venue = String(body.venue || '').trim();
    const address = String(body.address || '').trim();
    const city = String(body.city || '').trim();
    const image_key = String(body.image_key || 'tech').trim();
    if (!name || !description || !date || !time || !venue || !address || !city) {
      throw Object.assign(new Error('Fill in every event field before publishing.'), { status: 400 });
    }
    if (!isEventDateTime(date, time)) throw Object.assign(new Error('Enter a valid event date and time.'), { status: 400 });
    const types = parseTicketTypes(body.ticketTypes);
    const id = tx((database) => {
      const info = database.prepare(`
        INSERT INTO events (organizer_id, name, description, category, date, time, venue, address, city, image_key, status)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'published')
      `).run(req.user.id, name, description, category, date, time, venue, address, city, image_key);
      const eventId = Number(info.lastInsertRowid);
      for (const t of types) {
        database.prepare('INSERT INTO ticket_types (event_id, name, price_paise, capacity, sold, sort_order) VALUES (?,?,?,?,0,?)')
          .run(eventId, t.name, t.price_paise, t.capacity, t.sort_order);
      }
      return eventId;
    });
    const bundle = loadEventBundle(id);
    res.status(201).json(bundle);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
});

app.put('/api/organizer/events/:id', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  const found = assertOrgEvent(req.user, Number(req.params.id));
  if (found.error) return sendError(res, found.status, found.error);
  try {
    const body = req.body || {};
    const db = getDb();
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();
    const date = String(body.date || '').trim();
    const time = String(body.time || '').trim();
    const venue = String(body.venue || '').trim();
    const address = String(body.address || '').trim();
    const city = String(body.city || '').trim();
    if (!name || !description || !date || !time || !venue || !address || !city) {
      throw Object.assign(new Error('Fill in every event field before saving.'), { status: 400 });
    }
    if (!isEventDateTime(date, time)) throw Object.assign(new Error('Enter a valid event date and time.'), { status: 400 });
    const existing = db.prepare('SELECT * FROM ticket_types WHERE event_id = ?').all(found.event.id);
    const soldMap = Object.fromEntries(existing.map((t) => [t.id, t.sold]));
    const types = parseTicketTypes(body.ticketTypes, soldMap);
    tx((database) => {
      database.prepare(`
        UPDATE events SET name=?, description=?, category=?, date=?, time=?, venue=?, address=?, city=?, image_key=?, status=?
        WHERE id=?
      `).run(
        name, description, String(body.category || found.event.category),
        date, time, venue, address,
        city, String(body.image_key || found.event.image_key),
        body.status === 'cancelled' ? 'cancelled' : 'published', found.event.id,
      );
      const keep = types.filter((t) => t.id).map((t) => t.id);
      if (keep.length) {
        database.prepare(`DELETE FROM ticket_types WHERE event_id = ? AND id NOT IN (${keep.map(() => '?').join(',')}) AND sold = 0`)
          .run(found.event.id, ...keep);
      }
      for (const t of types) {
        if (t.id) {
          database.prepare('UPDATE ticket_types SET name=?, price_paise=?, capacity=?, sort_order=? WHERE id=? AND event_id=?')
            .run(t.name, t.price_paise, t.capacity, t.sort_order, t.id, found.event.id);
        } else {
          database.prepare('INSERT INTO ticket_types (event_id, name, price_paise, capacity, sold, sort_order) VALUES (?,?,?,?,0,?)')
            .run(found.event.id, t.name, t.price_paise, t.capacity, t.sort_order);
        }
      }
    });
    res.json(loadEventBundle(found.event.id));
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
});

app.delete('/api/organizer/events/:id', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  const found = assertOrgEvent(req.user, Number(req.params.id));
  if (found.error) return sendError(res, found.status, found.error);
  const sold = getDb().prepare('SELECT COALESCE(SUM(sold),0) AS s FROM ticket_types WHERE event_id = ?').get(found.event.id).s;
  if (sold > 0) return sendError(res, 400, 'This event has bookings. Cancel it instead of deleting.');
  getDb().prepare('DELETE FROM events WHERE id = ?').run(found.event.id);
  res.json({ ok: true });
});

function logScan(db, eventId, organizerId, ticketPublicId, result) {
  try {
    db.prepare('INSERT INTO scan_attempts (event_id, organizer_id, ticket_public_id, result, created_at) VALUES (?,?,?,?,?)')
      .run(eventId, organizerId, ticketPublicId || null, result, Date.now());
  } catch { /* logging must never break a scan */ }
}

function attendeeInfo(db, ticket, eventName) {
  const buyer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(ticket.user_id) || {};
  const tier = db.prepare('SELECT name FROM ticket_types WHERE id = ?').get(ticket.ticket_type_id);
  const booking = db.prepare('SELECT public_id FROM bookings WHERE id = ?').get(ticket.booking_id);
  const siblings = db.prepare('SELECT id FROM tickets WHERE booking_id = ? ORDER BY id').all(ticket.booking_id);
  return {
    holder: ticket.holder_name,
    email: buyer.email || '',
    phone: buyer.phone || '',
    event: eventName,
    ticketType: tier ? tier.name : '',
    ticketId: ticket.public_id,
    bookingId: booking ? booking.public_id : '',
    ticketNumber: siblings.findIndex((x) => x.id === ticket.id) + 1,
    ticketsInBooking: siblings.length,
  };
}

app.post('/api/organizer/checkin', authRequired, requireRole('organizer', 'admin'), (req, res) => {
  const eventId = Number((req.body || {}).eventId);
  const payload = String((req.body || {}).payload || '').trim();
  const found = assertOrgEvent(req.user, eventId);
  if (found.error) return sendError(res, found.status, found.error);
  const db = getDb();
  res.set('Cache-Control', 'no-store');

  const reply = (result, message, extra = {}, ticketPublicId = null) => {
    logScan(db, eventId, req.user.id, ticketPublicId, result);
    return res.json({ result, message, stats: scanStats(db, eventId), ...extra });
  };

  const parsed = parsePayload(payload);
  if (!parsed) return reply('invalid', 'Not a valid EventPass QR');
  const ticket = db.prepare('SELECT * FROM tickets WHERE public_id = ?').get(parsed.publicId);
  if (!ticket) return reply('invalid', 'Not a valid EventPass QR');

  // Signature first: nothing about a ticket is revealed to someone who can't prove they hold a genuine pass.
  const verified = verifyPayload(ticket, parsed);
  if (!verified.ok && verified.reason !== 'expired') return reply('invalid', 'Not a valid EventPass QR', {}, ticket.public_id);

  if (ticket.event_id !== eventId) return reply('wrong_event', 'Ticket is for a different event', {}, ticket.public_id);
  if (ticket.status === 'cancelled') {
    return reply('cancelled', 'Ticket cancelled', { attendee: attendeeInfo(db, ticket, found.event.name) }, ticket.public_id);
  }

  if (!verified.ok) { // genuine signature, wrong time window
    const used = ticket.status === 'used';
    return reply('expired', 'Expired pass. Ask for the live Smart Pass', {
      detail: used
        ? 'This ticket has already been used. This looks like a copied QR.'
        : 'This QR is older than 15 seconds. It was likely a screenshot or a photo of one.',
      attendee: attendeeInfo(db, ticket, found.event.name),
    }, ticket.public_id);
  }

  if (verified.kind === 'receipt') {
    return reply('static', 'Identity confirmed. Not valid for entry', {
      detail: `Printed/downloaded copy. Ask ${ticket.holder_name} to open the live Smart Pass on their phone.`,
      attendee: attendeeInfo(db, ticket, found.event.name),
      ticketStatus: ticket.status,
    }, ticket.public_id);
  }

  try {
    const out = tx((database) => {
      const fresh = database.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
      if (fresh.status !== 'confirmed') return { used: true };
      const upd = database.prepare("UPDATE tickets SET status = 'used' WHERE id = ? AND status = 'confirmed'").run(fresh.id);
      if (upd.changes !== 1) return { used: true };
      database.prepare('INSERT INTO check_ins (ticket_id, event_id, organizer_id, token_window) VALUES (?,?,?,?)')
        .run(fresh.id, eventId, req.user.id, verified.window);
      return { used: false, fresh };
    });
    if (out.used) {
      const prev = db.prepare('SELECT scanned_at FROM check_ins WHERE ticket_id = ?').get(ticket.id);
      return reply('used', 'Ticket already used', {
        detail: prev ? `Checked in at ${prev.scanned_at} UTC` : null,
        attendee: attendeeInfo(db, ticket, found.event.name),
      }, ticket.public_id);
    }
    return reply('ok', 'Ticket verified', { attendee: attendeeInfo(db, out.fresh, found.event.name) }, ticket.public_id);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
});

app.use('/api', (_req, res) => sendError(res, 404, 'Not found.'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

getDb();
setInterval(() => {
  try { expireLocks(); } catch (e) { console.error(e); }
}, 5000).unref();

app.listen(PORT, () => {
  console.log(`EventPass running at http://localhost:${PORT}`);
});
