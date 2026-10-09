const crypto = require('node:crypto');

/**
 * Smart Pass tokens.
 *
 * Two kinds of QR are issued, both signed with the ticket's own secret:
 *
 *   EP2  "live"     rolling pass. Carries buyer/ticket claims plus the current
 *                   15-second time window. Only this kind admits a person.
 *   EPR  "receipt"  static pass for the downloadable/printed copy. Carries the
 *                   same buyer/ticket claims but no window, so it can prove who
 *                   bought the ticket without being usable for entry.
 *
 * Claims are readable (base64url JSON) but cannot be altered: the HMAC covers
 * every field. Contact details (email/phone) are never put in the QR; the
 * organizer's scanner looks them up server-side after the signature checks out.
 */

const PERIOD_MS = 15_000;
const LIVE = 'EP2';
const RECEIPT = 'EPR';
const NAME_MAX = 40;

// A scan that crosses a window boundary in flight (camera -> network -> server)
// is still honoured for this long. A screenshot is far older than this.
function graceMs() {
  const n = Number(process.env.EVENTPASS_QR_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

function timeWindow(at = Date.now()) {
  return Math.floor(at / PERIOD_MS);
}

function remainingMs(at = Date.now()) {
  return PERIOD_MS - (at % PERIOD_MS);
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function sign(secret, kind, body) {
  return crypto.createHmac('sha256', secret).update(`${kind}.${body}`).digest('base64url').slice(0, 24);
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** ctx = { bookingPublicId, tier } */
function claimsFor(ticket, ctx) {
  return [ticket.public_id, ctx.bookingPublicId, ticket.event_id, ctx.tier, cleanName(ticket.holder_name)];
}

function encodePayload(ticket, ctx, at = Date.now()) {
  const body = b64([...claimsFor(ticket, ctx), timeWindow(at)]);
  return `${LIVE}.${body}.${sign(ticket.secret, 'L', body)}`;
}

function encodeReceipt(ticket, ctx) {
  const body = b64(claimsFor(ticket, ctx));
  return `${RECEIPT}.${body}.${sign(ticket.secret, 'R', body)}`;
}

function parsePayload(payload) {
  if (typeof payload !== 'string' || payload.length > 600) return null;
  const parts = payload.trim().split('.');
  if (parts.length !== 3) return null;
  const [prefix, body, sig] = parts;
  const kind = prefix === LIVE ? 'live' : prefix === RECEIPT ? 'receipt' : null;
  if (!kind || !body || !sig) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(claims)) return null;
  const [publicId, bookingPublicId, eventId, tier, name, window] = claims;
  if (typeof publicId !== 'string' || !publicId) return null;
  if (kind === 'live' && !Number.isInteger(window)) return null;
  return { kind, publicId, bookingPublicId, eventId, tier, name, window, body, sig };
}

/**
 * reason: 'forged'  signature does not match this ticket
 *         'expired' genuine signature, but not the current window (screenshot / stale)
 */
function verifyPayload(ticket, parsed, at = Date.now()) {
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (parsed.publicId !== ticket.public_id) return { ok: false, reason: 'forged' };
  const expected = sign(ticket.secret, parsed.kind === 'live' ? 'L' : 'R', parsed.body);
  const a = Buffer.from(parsed.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'forged' };
  if (parsed.kind === 'receipt') return { ok: true, kind: 'receipt' };

  const current = timeWindow(at);
  const justRolled = parsed.window === current - 1 && at % PERIOD_MS < graceMs();
  if (parsed.window !== current && !justRolled) return { ok: false, reason: 'expired', kind: 'live' };
  return { ok: true, kind: 'live', window: parsed.window };
}

function newTicketSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function newPublicId(prefix) {
  const n = crypto.randomInt(1_000_000, 9_999_999);
  return `${prefix}-${n}`;
}

function paymentRef() {
  return `PAY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

module.exports = {
  PERIOD_MS,
  timeWindow,
  remainingMs,
  encodePayload,
  encodeReceipt,
  parsePayload,
  verifyPayload,
  newTicketSecret,
  newPublicId,
  paymentRef,
};
