const crypto = require('node:crypto');

const COOKIE = 'eventpass_session';
const JWT_TTL_SEC = 60 * 60 * 24 * 14;

function signingKey() {
  return process.env.EVENTPASS_SECRET || 'eventpass-local-dev-key-change-in-prod';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const next = crypto.scryptSync(password, salt, 32).toString('hex');
  if (hash.length !== next.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'));
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', signingKey()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || token.split('.').length !== 3) return null;
  const [header, body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', signingKey()).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function issueSession(res, user) {
  const token = signToken({
    sub: user.id,
    role: user.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + JWT_TTL_SEC,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: JWT_TTL_SEC * 1000,
    path: '/',
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, phone: row.phone || '', role: row.role };
}

function loadUser(id) {
  const { getDb } = require('./db');
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function authRequired(req, res, next) {
  const payload = verifyToken(req.cookies[COOKIE]);
  if (!payload) return res.status(401).json({ error: 'Please sign in to continue.' });
  const user = loadUser(payload.sub);
  if (!user) return res.status(401).json({ error: 'Session is no longer valid.' });
  req.user = publicUser(user);
  req.userRow = user;
  next();
}

function optionalAuth(req, res, next) {
  const payload = verifyToken(req.cookies[COOKIE]);
  if (payload) {
    const user = loadUser(payload.sub);
    if (user) {
      req.user = publicUser(user);
      req.userRow = user;
    }
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this area.' });
    }
    next();
  };
}

module.exports = {
  COOKIE,
  signToken,
  hashPassword,
  verifyPassword,
  issueSession,
  clearSession,
  publicUser,
  authRequired,
  optionalAuth,
  requireRole,
};
