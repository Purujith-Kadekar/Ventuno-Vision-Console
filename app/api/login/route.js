import {
  checkCredentials, credentialsConfigured, makeToken, COOKIE, TTL_SECONDS,
} from '../../../lib/auth';
import { clientIp, isLimited, recordFailure, clearFailures, RATE_LIMIT } from '../../../lib/rate-limit';

export async function POST(req) {
  if (!credentialsConfigured()) {
    return Response.json({
      ok: false,
      error: 'The server is not configured: set WEB_USERNAME, WEB_PIN and SESSION_SECRET.',
    }, { status: 500 });
  }

  const ip = clientIp(req);
  if (isLimited(ip)) {
    return Response.json({
      ok: false,
      error: `Too many failed attempts. Try again in ${Math.round(RATE_LIMIT.windowMs / 60000)} minutes.`,
    }, { status: 429, headers: { 'Retry-After': String(Math.round(RATE_LIMIT.windowMs / 1000)) } });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  if (!checkCredentials(body.username, body.pin)) {
    recordFailure(ip);
    return Response.json({ ok: false, error: 'Invalid username or PIN' },
      { status: 401 });
  }
  clearFailures(ip);

  let token;
  try {
    token = makeToken(body.username);
  } catch (err) {
    return Response.json({ ok: false, error: String(err.message || err) },
      { status: 500 });
  }
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return Response.json({ ok: true }, {
    headers: {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${TTL_SECONDS}; SameSite=Lax${secure}`,
      'Cache-Control': 'no-store',
    },
  });
}
