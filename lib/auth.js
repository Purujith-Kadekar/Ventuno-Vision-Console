// ============================================================
//  lib/auth.js - signed session cookie (no external dependency)
//
//  The login page posts the username + PIN, the server compares them with
//  WEB_USERNAME / WEB_PIN and sets an HttpOnly cookie:
//
//      ventuno_vision = <base64url(json)>.<hmac-sha256>
//
//  The camera page and every browser-facing API verify the signature and
//  the expiry. The board authenticates separately with X-Api-Key.
// ============================================================

import crypto from 'crypto';

export const COOKIE = 'ventuno_vision';
export const TTL_SECONDS = 24 * 60 * 60;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    // Fail closed: a known default secret would let anyone forge a cookie.
    throw new Error('SESSION_SECRET is not configured');
  }
  return 'dev-only-change-me';
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function makeToken(username, ttl = TTL_SECONDS) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Math.floor(Date.now() / 1000) + ttl,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected;
  try {
    expected = sign(payload);
  } catch {
    return null;                                // misconfigured server
  }
  if (!safeEqual(mac, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.exp !== 'number' || data.exp < Date.now() / 1000) {
    return null;
  }
  return data;
}

export function checkCredentials(username, pin) {
  const wantUser = process.env.WEB_USERNAME;
  const wantPin = process.env.WEB_PIN;
  if (!wantUser || !wantPin) {
    // In development fall back to the documented defaults; in production a
    // missing value is a configuration error (credentialsConfigured()).
    if (process.env.NODE_ENV === 'production') return false;
  }
  return safeEqual(username || '', wantUser || 'ventuno')
    && safeEqual(pin || '', wantPin || '1234');
}

// False when production is missing a login secret (the login route says so
// instead of silently accepting the documented development defaults).
export function credentialsConfigured() {
  const ok = !!(process.env.WEB_USERNAME && process.env.WEB_PIN);
  if (process.env.NODE_ENV !== 'production') return true;
  return ok && !!process.env.SESSION_SECRET;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// `req` is a Web Request (route handlers). Returns {u, exp} or null.
export function getSession(req) {
  const cookies = parseCookies(req.headers.get('cookie'));
  return verifyToken(cookies[COOKIE]);
}

// `req` is a Web Request. The board sends X-Api-Key.
export function boardAuthorized(req) {
  const key = process.env.SYNC_API_KEY;
  if (!key) {
    // Fail closed. Treating "no key configured" as "anyone is the board"
    // would let the whole internet poll the session and post relay answers.
    return false;
  }
  return safeEqual(req.headers.get('x-api-key') || '', key);
}

// Diagnostics for /api/health: what is configured, never the values.
export function configStatus() {
  return {
    username: !!process.env.WEB_USERNAME,
    pin: !!process.env.WEB_PIN,
    sessionSecret: !!process.env.SESSION_SECRET,
    syncKey: !!process.env.SYNC_API_KEY,
    firestore: !!process.env.FIREBASE_SERVICE_ACCOUNT,
  };
}
