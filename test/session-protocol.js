// ============================================================
//  test/session-protocol.js - the contract between the web UI and the board
//
//  Run a server first:
//      npm run dev            # or: npm run build && npm start
//      node test/session-protocol.js http://localhost:3000
//
//  The board identifies itself with X-Api-Key; the browser with the signed
//  session cookie. Both are checked here.
// ============================================================

const base = process.argv[2] || 'http://localhost:3000';
const KEY = process.env.SYNC_API_KEY || 'testkey123';
const USER = process.env.WEB_USERNAME || 'ventuno';
const PIN = process.env.WEB_PIN || '1234';

let pass = 0;
let fail = 0;
let cookie = '';

function ok(cond, what) {
  if (cond) {
    pass++;
    console.log(`  ok   ${what}`);
  } else {
    fail++;
    console.log(`  FAIL ${what}`);
  }
}

async function call(path, { method = 'GET', body, board = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (board) headers['X-Api-Key'] = KEY;
  else if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`session protocol against ${base}\n`);

  console.log('health');
  let r = await call('/api/health');
  ok(r.status === 200 && r.json.ok, 'the app answers /api/health');
  ok(r.json.configured && r.json.configured.syncKey === true,
    'the board key is configured (no anonymous board)');

  console.log('login');
  r = await call('/api/login', { method: 'POST', body: { username: USER, pin: 'wrong' } });
  ok(r.status === 401, 'a wrong PIN is rejected (401)');
  r = await call('/api/login', { method: 'POST', body: { username: USER, pin: PIN } });
  ok(r.status === 200 && r.json.ok, 'the right PIN is accepted');
  ok(cookie.startsWith('ventuno_vision='), 'the session cookie is set');

  console.log('\nsession');
  const savedCookie = cookie;
  cookie = '';
  r = await call('/api/session');
  ok(r.status === 401, 'no cookie, no session (401)');
  cookie = savedCookie;
  r = await call('/api/session', { board: true });
  ok(r.status === 401 || r.status === 200, 'the board may poll with its key');
  r = await call('/api/session', { method: 'POST', body: { action: 'start' } });
  ok(r.status === 200 && r.json.state === 'requested', 'the browser asks for vision');
  r = await call('/api/session', { board: true });
  ok(r.json.session.state === 'requested', 'the board sees "requested"');
  r = await call('/api/session', { method: 'POST', body: { action: 'ready' }, board: true });
  ok(r.status === 200, 'the board reports "ready"');
  r = await call('/api/session', { board: true });
  ok(r.json.session.state === 'ready', 'the browser sees "ready"');

  console.log('\nrelay');
  r = await call('/api/relay', {
    method: 'POST',
    body: { prompt: 'What is this?', image_b64: 'AAAA', want_tts: false },
  });
  ok(r.status === 200 && !!r.json.id, 'the browser queues a frame');
  const id = r.json.id;
  r = await call('/api/relay?job=1', { board: true });
  ok(r.json.job && r.json.job.id === id, 'the board takes the frame');
  ok(r.json.job.prompt === 'What is this?', 'the prompt travels with it');
  r = await call('/api/relay?job=1', { board: true });
  ok(r.json.job === null, 'the frame is taken only once');
  r = await call('/api/relay', { method: 'POST', body: { id, text: 'a cat' }, board: true });
  ok(r.status === 200, 'the board posts the answer');
  r = await call(`/api/relay?id=${id}`);
  ok(r.status === 200 && r.json.answer.text === 'a cat', 'the browser gets the answer');
  r = await call('/api/relay?id=does-not-exist');
  ok(r.status === 204, 'an unknown id is 204 (still waiting)');

  console.log('\nrelease');
  r = await call('/api/session', { method: 'POST', body: { action: 'stop' } });
  ok(r.status === 200 && r.json.state === 'idle', 'the browser releases the vision role');
  r = await call('/api/session', { board: true });
  ok(r.json.session.state === 'idle', 'the board sees "idle"');

  // last, because it locks this client out for a few minutes
  console.log('\nbrute force');
  let limited = false;
  for (let i = 0; i < 6; i++) {
    r = await call('/api/login', { method: 'POST', body: { username: USER, pin: 'nope' } });
    if (r.status === 429) limited = true;
  }
  ok(limited, 'repeated wrong PINs are rate-limited (429)');
  r = await call('/api/login', { method: 'POST', body: { username: USER, pin: PIN } });
  ok(r.status === 429, 'a correct PIN is refused while limited');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
