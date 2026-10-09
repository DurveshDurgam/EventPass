const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');
const { newTicketSecret, newPublicId } = require('./qr');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'eventpass.db');

let db;

function getDb() {
  if (!db) openDb();
  return db;
}

function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 3000');
  migrate();
  migrateColumns();
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n === 0) seed();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL CHECK(role IN ('customer','organizer','admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organizer_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      venue TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      image_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ticket_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price_paise INTEGER NOT NULL CHECK(price_paise >= 0),
      capacity INTEGER NOT NULL CHECK(capacity >= 0),
      sold INTEGER NOT NULL DEFAULT 0 CHECK(sold >= 0),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ticket_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      event_id INTEGER NOT NULL REFERENCES events(id),
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','converted','released','expired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ticket_lock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lock_id INTEGER NOT NULL REFERENCES ticket_locks(id) ON DELETE CASCADE,
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0)
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      event_id INTEGER NOT NULL REFERENCES events(id),
      lock_id INTEGER REFERENCES ticket_locks(id),
      status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled')),
      amount_paise INTEGER NOT NULL,
      fee_paise INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS booking_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
      quantity INTEGER NOT NULL,
      unit_price_paise INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
      event_id INTEGER NOT NULL REFERENCES events(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      holder_name TEXT NOT NULL,
      secret TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled','used')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS check_ins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
      event_id INTEGER NOT NULL REFERENCES events(id),
      organizer_id INTEGER NOT NULL REFERENCES users(id),
      token_window INTEGER NOT NULL,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      amount_paise INTEGER NOT NULL,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      reference TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pricing_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
      old_price_paise INTEGER NOT NULL,
      new_price_paise INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'smart_pricing',
      changed_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      organizer_id INTEGER NOT NULL REFERENCES users(id),
      ticket_public_id TEXT,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_event ON pricing_changes(event_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_scans_event ON scan_attempts(event_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_org ON events(organizer_id);
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    CREATE INDEX IF NOT EXISTS idx_tt_event ON ticket_types(event_id);
    CREATE INDEX IF NOT EXISTS idx_locks_status ON ticket_locks(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_public ON tickets(public_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
  `);
}

function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Upgrades databases created by earlier versions without losing data.
function migrateColumns() {
  // Price is frozen when a seat is reserved, so a mid-checkout price change
  // (e.g. an applied Smart Pricing suggestion) never alters a held order.
  addColumnIfMissing('ticket_lock_items', 'unit_price_paise', 'INTEGER');
  db.exec(`
    UPDATE ticket_lock_items
    SET unit_price_paise = (SELECT price_paise FROM ticket_types WHERE id = ticket_lock_items.ticket_type_id)
    WHERE unit_price_paise IS NULL
  `);
}

function tx(fn) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function expireLocks(database = getDb()) {
  const now = Date.now();
  database.prepare(`
    UPDATE ticket_locks
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= ?
  `).run(now);
}

function lockedQty(database, ticketTypeId, excludeLockId = null) {
  const row = database.prepare(`
    SELECT COALESCE(SUM(li.quantity), 0) AS qty
    FROM ticket_lock_items li
    JOIN ticket_locks l ON l.id = li.lock_id
    WHERE li.ticket_type_id = ?
      AND l.status = 'active'
      AND l.expires_at > ?
      AND (? IS NULL OR l.id != ?)
  `).get(ticketTypeId, Date.now(), excludeLockId, excludeLockId);
  return row.qty;
}

function availableForType(database, ticketType) {
  const locked = lockedQty(database, ticketType.id);
  return Math.max(0, ticketType.capacity - ticketType.sold - locked);
}

function eventCapacity(database, eventId) {
  expireLocks(database);
  const types = database.prepare('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, id').all(eventId);
  return types.map((t) => ({
    ...plain(t),
    available: availableForType(database, t),
    remaining: availableForType(database, t),
  }));
}

function plain(row) {
  if (!row) return null;
  return { ...row };
}

function lockSnapshot(database, lockId) {
  const lock = database.prepare('SELECT * FROM ticket_locks WHERE id = ?').get(lockId);
  if (!lock) return null;
  const items = database.prepare(`
    SELECT li.id, li.lock_id, li.ticket_type_id, li.quantity, tt.name,
           COALESCE(li.unit_price_paise, tt.price_paise) AS price_paise
    FROM ticket_lock_items li
    JOIN ticket_types tt ON tt.id = li.ticket_type_id
    WHERE li.lock_id = ?
  `).all(lockId).map(plain);
  const event = plain(database.prepare('SELECT * FROM events WHERE id = ?').get(lock.event_id));
  const qty = items.reduce((s, i) => s + i.quantity, 0);
  const subtotal = items.reduce((s, i) => s + i.quantity * i.price_paise, 0);
  return { ...plain(lock), items, event, quantity: qty, subtotal_paise: subtotal, remainingMs: Math.max(0, lock.expires_at - Date.now()) };
}

function resetAndSeed() {
  if (db) {
    db.close();
    db = null;
  }
  for (const f of ['eventpass.db', 'eventpass.db-wal', 'eventpass.db-shm']) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  openDb();
}

function seed() {
  const password = hashPassword('EventPass@2026');
  const insertUser = db.prepare('INSERT INTO users (email, password_hash, name, phone, role) VALUES (?,?,?,?,?)');
  insertUser.run('ananya.sharma@eventpass.in', password, 'Ananya Sharma', '+91 98765 44102', 'customer');
  insertUser.run('rahul.iyer@eventpass.in', password, 'Rahul Iyer', '+91 98200 11834', 'customer');
  insertUser.run('meera.kapoor@eventpass.in', password, 'Meera Kapoor', '+91 98111 22009', 'customer');
  insertUser.run('priya.mehta@eventpass.in', password, 'Priya Mehta', '+91 99000 33421', 'organizer');
  insertUser.run('karan.desai@eventpass.in', password, 'Karan Desai', '+91 97654 88210', 'organizer');
  insertUser.run('admin@eventpass.in', password, 'EventPass Admin', '+91 90000 00001', 'admin');

  const organ = db.prepare("SELECT id FROM users WHERE email = 'priya.mehta@eventpass.in'").get().id;
  const organ2 = db.prepare("SELECT id FROM users WHERE email = 'karan.desai@eventpass.in'").get().id;
  const ananya = db.prepare("SELECT id FROM users WHERE email = 'ananya.sharma@eventpass.in'").get().id;
  const rahul = db.prepare("SELECT id FROM users WHERE email = 'rahul.iyer@eventpass.in'").get().id;
  const meera = db.prepare("SELECT id FROM users WHERE email = 'meera.kapoor@eventpass.in'").get().id;

  const events = [
    {
      organizer_id: organ, name: 'TechFest 2026', category: 'Workshops',
      date: '2026-11-08', time: '09:30', venue: 'Convocation Hall, IIT Bombay',
      address: 'IIT Bombay, Powai, Mumbai 400076', city: 'Mumbai', image_key: 'tech',
      description: 'India’s student-built technology festival returns to Powai with hardware labs, product demos, and a packed speaker stage. Expect robotics arenas, overnight hack pits, and recruiter booths from product companies that actually hire from campus.',
      types: [
        { name: 'Early Bird', price: 79900, cap: 180 },
        { name: 'General Admission', price: 129900, cap: 620 },
        { name: 'VIP', price: 349900, cap: 80 },
      ],
    },
    {
      organizer_id: organ, name: 'Mumbai Music Night', category: 'Music',
      date: '2026-11-14', time: '19:30', venue: 'NCPA Tata Theatre',
      address: 'Nariman Point, Mumbai 400021', city: 'Mumbai', image_key: 'music',
      description: 'An evening of jazz, Konkani folk interpolations, and a city brass section. Seated show, doors at 6:45 pm. Bar service in the foyer; no re-entry after the second set.',
      types: [
        { name: 'Early Bird', price: 99900, cap: 60 },
        { name: 'General Admission', price: 180000, cap: 280 },
        { name: 'VIP', price: 420000, cap: 40 },
      ],
    },
    {
      organizer_id: organ, name: 'Startup Summit India', category: 'Workshops',
      date: '2026-10-24', time: '10:00', venue: 'NIMHANS Convention Centre',
      address: 'Hosur Road, Bengaluru 560029', city: 'Bengaluru', image_key: 'summit',
      description: 'Founders, operators, and seed investors in one hall. The programme covers fundraising without theatrics, hiring the first twenty, and distribution in India. Office hours with visiting partners run in the afternoon rooms.',
      types: [
        { name: 'General Admission', price: 249900, cap: 500 },
        { name: 'Premium', price: 799900, cap: 70 },
      ],
    },
    {
      organizer_id: organ2, name: 'College Cultural Festival', category: 'Workshops',
      date: '2026-12-05', time: '16:00', venue: 'Main Amphitheatre, Fergusson College',
      address: 'FC Road, Pune 411004', city: 'Pune', image_key: 'culture',
      description: 'Dance, theatre, and a night market stretching from the amphitheatre to the old library lawn. Day passes include all outdoor stages. Food stalls are cashless.',
      types: [
        { name: 'General Admission', price: 49900, cap: 900 },
        { name: 'VIP', price: 149900, cap: 120 },
      ],
    },
    {
      organizer_id: organ, name: 'AI & Innovation Expo', category: 'Workshops',
      date: '2026-11-21', time: '09:00', venue: 'HICC, Hyderabad',
      address: 'Hitex Road, Hyderabad 500081', city: 'Hyderabad', image_key: 'ai',
      description: 'Applied machine learning on the show floor: language tools for Indic languages, factory vision, and public-sector pilots. Talks run on two stages; the expo floor stays open through the afternoon.',
      types: [
        { name: 'Early Bird', price: 149900, cap: 200 },
        { name: 'General Admission', price: 219900, cap: 450 },
        { name: 'Premium', price: 549900, cap: 60 },
      ],
    },
    {
      organizer_id: organ, name: 'Stand-Up Comedy Night', category: 'Comedy',
      date: '2026-10-18', time: '20:00', venue: 'The Habitat, Khar',
      address: '16th Road, Khar West, Mumbai 400052', city: 'Mumbai', image_key: 'comedy',
      description: 'A tight room, two headliners, and a local opener. 18+ only. Last entry 8:20 pm. This one sells through — live locks are there for a reason.',
      types: [
        { name: 'General Admission', price: 79900, cap: 15 },
        { name: 'VIP', price: 159900, cap: 18 },
      ],
    },
  ];

  const insEvent = db.prepare(`
    INSERT INTO events (organizer_id, name, description, category, date, time, venue, address, city, image_key, status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'published')
  `);
  const insType = db.prepare(`
    INSERT INTO ticket_types (event_id, name, price_paise, capacity, sold, sort_order)
    VALUES (?,?,?,?,0,?)
  `);

  const eventIds = {};
  for (const e of events) {
    const info = insEvent.run(e.organizer_id, e.name, e.description, e.category, e.date, e.time, e.venue, e.address, e.city, e.image_key);
    const eid = Number(info.lastInsertRowid);
    eventIds[e.name] = eid;
    e.types.forEach((t, i) => insType.run(eid, t.name, t.price, t.cap, i));
  }

  function book({ userId, holder, eventName, typeName, qty, hoursAgo, status = 'confirmed' }) {
    const event = db.prepare('SELECT * FROM events WHERE name = ?').get(eventName);
    const type = db.prepare('SELECT * FROM ticket_types WHERE event_id = ? AND name = ?').get(event.id, typeName);
    const subtotal = type.price_paise * qty;
    const fee = Math.round(subtotal * 0.025);
    const created = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const publicId = newPublicId('EP');
    const b = db.prepare(`
      INSERT INTO bookings (public_id, user_id, event_id, status, amount_paise, fee_paise, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(publicId, userId, event.id, status === 'used' ? 'confirmed' : status, subtotal + fee, fee, created);
    const bookingId = Number(b.lastInsertRowid);
    db.prepare('INSERT INTO booking_items (booking_id, ticket_type_id, quantity, unit_price_paise) VALUES (?,?,?,?)')
      .run(bookingId, type.id, qty, type.price_paise);
    db.prepare('INSERT INTO payments (booking_id, amount_paise, method, status, reference, created_at) VALUES (?,?,?,?,?,?)')
      .run(bookingId, subtotal + fee, 'upi', 'captured', newPublicId('PAY'), created);
    if (status !== 'cancelled') {
      db.prepare('UPDATE ticket_types SET sold = sold + ? WHERE id = ?').run(qty, type.id);
    }
    const ticketStatus = status === 'cancelled' ? 'cancelled' : status === 'used' ? 'used' : 'confirmed';
    let firstTicketId = null;
    for (let i = 0; i < qty; i += 1) {
      const t = db.prepare(`
        INSERT INTO tickets (public_id, booking_id, ticket_type_id, event_id, user_id, holder_name, secret, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(newPublicId('TK'), bookingId, type.id, event.id, userId, holder, newTicketSecret(), ticketStatus, created);
      if (firstTicketId == null) firstTicketId = Number(t.lastInsertRowid);
    }
    if (ticketStatus === 'used') {
      db.prepare('INSERT INTO check_ins (ticket_id, event_id, organizer_id, token_window, scanned_at) VALUES (?,?,?,?,?)')
        .run(firstTicketId, event.id, event.organizer_id, 0, created);
    }
  }

  const pattern = [
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'TechFest 2026', typeName: 'General Admission', qty: 2, hoursAgo: 2 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'TechFest 2026', typeName: 'General Admission', qty: 1, hoursAgo: 3 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'TechFest 2026', typeName: 'VIP', qty: 1, hoursAgo: 5 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'TechFest 2026', typeName: 'Early Bird', qty: 2, hoursAgo: 8 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'TechFest 2026', typeName: 'General Admission', qty: 3, hoursAgo: 11 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'TechFest 2026', typeName: 'General Admission', qty: 2, hoursAgo: 14 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'TechFest 2026', typeName: 'General Admission', qty: 1, hoursAgo: 18 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'Mumbai Music Night', typeName: 'General Admission', qty: 2, hoursAgo: 6 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'Mumbai Music Night', typeName: 'VIP', qty: 1, hoursAgo: 20 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'Mumbai Music Night', typeName: 'Early Bird', qty: 1, hoursAgo: 30 },
    ...[150, 132, 118, 101, 86, 70, 58, 47].map((h, i) => ({
      userId: i % 2 ? rahul : meera, holder: i % 2 ? 'Rahul Iyer' : 'Meera Kapoor',
      eventName: 'Mumbai Music Night', typeName: 'Early Bird', qty: 6, hoursAgo: h,
    })),
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'Startup Summit India', typeName: 'General Admission', qty: 1, hoursAgo: 4 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'Startup Summit India', typeName: 'Premium', qty: 1, hoursAgo: 9 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'Startup Summit India', typeName: 'General Admission', qty: 2, hoursAgo: 16 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'AI & Innovation Expo', typeName: 'General Admission', qty: 2, hoursAgo: 7 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'AI & Innovation Expo', typeName: 'Early Bird', qty: 1, hoursAgo: 22 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'Stand-Up Comedy Night', typeName: 'General Admission', qty: 2, hoursAgo: 1 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'Stand-Up Comedy Night', typeName: 'General Admission', qty: 2, hoursAgo: 3 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'Stand-Up Comedy Night', typeName: 'VIP', qty: 1, hoursAgo: 12 },
    { userId: rahul, holder: 'Rahul Iyer', eventName: 'Stand-Up Comedy Night', typeName: 'General Admission', qty: 3, hoursAgo: 26 },
    { userId: meera, holder: 'Meera Kapoor', eventName: 'College Cultural Festival', typeName: 'General Admission', qty: 4, hoursAgo: 40 },
    { userId: ananya, holder: 'Ananya Sharma', eventName: 'Mumbai Music Night', typeName: 'General Admission', qty: 1, hoursAgo: 48, status: 'used' },
    { userId: ananya, holder: 'Ananya Sharma', eventName: 'College Cultural Festival', typeName: 'General Admission', qty: 2, hoursAgo: 72, status: 'cancelled' },
  ];
  for (const row of pattern) book(row);

}

module.exports = {
  getDb,
  openDb,
  tx,
  expireLocks,
  lockedQty,
  availableForType,
  eventCapacity,
  lockSnapshot,
  resetAndSeed,
  plain,
};
