// ============================================================
//  lib/rate-limit.js - slow down PIN guessing
//
//  A short PIN is the only thing between the internet and the camera.
//  This keeps a small per-instance window of failures per client IP.
//  On Vercel each serverless instance has its own map, so it is not a
//  global lock - but it still turns a fast brute force into a slow one,
//  and it costs nothing.
// ============================================================

const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;

const failures = new Map();               // ip -> { count, first }

function prune(now) {
  for (const [ip, rec] of failures) {
    if (now - rec.first > WINDOW_MS) failures.delete(ip);
  }
}

export function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return (fwd.split(',')[0] || '').trim() || 'unknown';
}

// true when this client must wait
export function isLimited(ip) {
  const now = Date.now();
  prune(now);
  const rec = failures.get(ip);
  return !!rec && rec.count >= MAX_FAILURES;
}

export function recordFailure(ip) {
  const now = Date.now();
  const rec = failures.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    failures.set(ip, { count: 1, first: now });
  } else {
    rec.count += 1;
  }
}

export function clearFailures(ip) {
  failures.delete(ip);
}

export const RATE_LIMIT = { windowMs: WINDOW_MS, maxFailures: MAX_FAILURES };
