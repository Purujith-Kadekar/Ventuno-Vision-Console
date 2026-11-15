// ============================================================
//  /api/session - the switch channel between the web UI and the board
//
//  Browser (session cookie):
//    POST {action:"start"}  -> state "requested" (+ id)
//    POST {action:"stop"}   -> state "idle"
//
//  Board (X-Api-Key):
//    GET                    -> { session, relay }
//    POST {action:"ready"}  -> the vision role is loaded
//    POST {action:"voice"}  -> the voice role is back
//    POST {action:"error", message} -> a switch failed
//
//  The board polls GET every 2 s; it is the only side that can change the
//  NPU, so the web UI never talks to the model directly.
// ============================================================

import { getState, setSessionState } from '../../../lib/store';
import { getSession, boardAuthorized } from '../../../lib/auth';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req) {
  if (!boardAuthorized(req) && !getSession(req)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const state = await getState();
  return Response.json({ ok: true, ...state }, { headers: NO_STORE });
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  const board = boardAuthorized(req);
  const user = !!getSession(req);
  if (!board && !user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const action = String(body.action || '');

  if (board && ['ready', 'voice', 'error'].includes(action)) {
    await setSessionState(action, {
      id: body.id,
      message: body.message ? String(body.message).slice(0, 300) : undefined,
    });
    return Response.json({ ok: true, state: action }, { headers: NO_STORE });
  }

  if (user && action === 'start') {
    const id = 'v' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6);
    await setSessionState('requested', { id });
    return Response.json({ ok: true, state: 'requested', id },
      { headers: NO_STORE });
  }

  if (user && action === 'stop') {
    await setSessionState('idle');
    return Response.json({ ok: true, state: 'idle' }, { headers: NO_STORE });
  }

  return Response.json({ ok: false, error: 'bad action' }, { status: 400 });
}
