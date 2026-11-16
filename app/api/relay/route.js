// ============================================================
//  /api/relay - the cloud path for a frame when the browser cannot
//  reach the board directly (HTTPS page -> HTTP LAN board is blocked
//  as mixed content).
//
//  Browser (session cookie):
//    POST {prompt, image_b64, want_tts} -> { id }
//    GET  ?id=<id>                      -> 200 { answer } | 204
//
//  Board (X-Api-Key):
//    GET  ?job=1                        -> { job } | { job:null }
//    POST {id, text, wav_b64?, error?}  -> { ok:true }
//
//  The board fetches the frame from this endpoint, runs the VL model
//  locally, and posts the answer back. Nothing is analysed in the cloud.
// ============================================================

import { queueJob, takeJob, putAnswer, getAnswer } from '../../../lib/store';
import { getSession, boardAuthorized } from '../../../lib/auth';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_B64 = 700_000;   // ~525 KB of binary; leaves headroom under 1 MiB

// Never answer with an empty 500: the board needs a reason it can log.
function failure(err) {
  return Response.json({
    ok: false,
    error: String((err && err.message) || err || 'store unavailable'),
  }, { status: 503, headers: NO_STORE });
}

export async function GET(req) {
  try {
    return await get(req);
  } catch (err) {
    return failure(err);
  }
}

async function get(req) {
  const url = new URL(req.url);
  if (boardAuthorized(req) && url.searchParams.get('job') === '1') {
    const job = await takeJob();
    return Response.json({ ok: true, job }, { headers: NO_STORE });
  }
  if (!getSession(req)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
  const answer = await getAnswer(id);
  if (!answer) return new Response(null, { status: 204, headers: NO_STORE });
  return Response.json({ ok: true, answer }, { headers: NO_STORE });
}

export async function POST(req) {
  try {
    return await post(req);
  } catch (err) {
    return failure(err);
  }
}

async function post(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // the board posting the result
  if (boardAuthorized(req) && body.id && body.text !== undefined) {
    await putAnswer({
      id: body.id,
      text: String(body.text || ''),
      // audio too large for the 1 MiB document is dropped; the text still arrives
      wav_b64: body.wav_b64 && String(body.wav_b64).length <= MAX_B64 ? body.wav_b64 : null,
      error: body.error ? String(body.error).slice(0, 500) : null,
      detect: body.detect || null,
    });
    return Response.json({ ok: true }, { headers: NO_STORE });
  }

  // the browser queueing a frame
  if (!getSession(req)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  if (!body.image_b64) {
    return Response.json({ ok: false, error: 'image_b64 required' },
      { status: 400 });
  }
  // The frame is stored in one Firestore document, which is capped at 1 MiB
  // (Vercel also rejects bodies over ~4.5 MB). Fail early with a clear error.
  if (String(body.image_b64).length > MAX_B64) {
    return Response.json({
      ok: false,
      error: 'image too large (compress it or lower the camera resolution)',
    }, { status: 413 });
  }
  const id = 'r' + Date.now().toString(36) +
    Math.random().toString(36).slice(2, 6);
  await queueJob({
    id,
    prompt: String(body.prompt || '').slice(0, 2000),
    image_b64: String(body.image_b64),
    want_tts: !!body.want_tts,
    // optional cheap detector run on the same frame (face | object)
    detect_kind: ['face', 'object'].includes(body.detect_kind)
      ? body.detect_kind : null,
    max_tokens: Math.min(400, Math.max(32, Number(body.max_tokens) || 160)),
  });
  return Response.json({ ok: true, id }, { headers: NO_STORE });
}
