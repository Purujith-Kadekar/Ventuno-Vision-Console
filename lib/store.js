// ============================================================
//  lib/store.js - the tiny shared state between the web UI and the board
//
//  ONE document holds everything:
//
//      session: { id, state, ts }        idle | requested | ready | voice | error
//      relay:   { job, answer }          one pending frame + its answer
//
//  Why one document: the board polls it every 2 s and the camera page polls
//  its own answer. A single read/write keeps the protocol trivial.
//
//  Firestore mode activates when FIREBASE_SERVICE_ACCOUNT is set (recommended
//  on Vercel: serverless instances do not share memory). Otherwise the same
//  API is served from memory + /tmp, which is enough for `npm run dev`.
//
//  IMPORTANT: a broken Firestore configuration used to throw inside every
//  request, so Vercel answered with an empty 500 and the board could not even
//  read the session. Now the store falls back to memory and records the exact
//  error, which /api/health?deep=1 reports. Nothing returns a blank 500.
// ============================================================

import fs from 'fs';

const STATE_FILE = process.env.VENTUNO_VISION_STATE || '/tmp/ventuno-vision.json';
const RETRY_MS = 30_000;          // do not hammer a broken Firestore
const COLLECTION = 'vision';
const DOC = 'main';

const EMPTY = () => ({
  session: { id: null, state: 'idle', ts: 0 },
  relay: { job: null, answer: null },
});

let memory = null;
let firestore = null;
let storeError = null;            // last Firestore failure, for /api/health
let retryAt = 0;

function rawServiceAccount() {
  return String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
}

// True when a service account is configured at all.
function firestoreActive() {
  return !!rawServiceAccount();
}

// Accepts the shapes people actually paste into Vercel:
//   * one-line JSON (jq -c .)
//   * pretty JSON with real newlines between fields
//   * one line where the private key contains literal \n
//   * base64 of any of the above
//   * the value wrapped in extra quotes
export function parseServiceAccount(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('FIREBASE_SERVICE_ACCOUNT is empty');
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = JSON.parse(text); } catch { /* keep the quoted text */ }
  }
  const candidates = [text];
  if (!text.startsWith('{')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.includes('{')) candidates.push(decoded);
    } catch { /* not base64 */ }
  }
  for (const candidate of candidates) {
    let obj;
    try { obj = JSON.parse(candidate); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (typeof obj.private_key === 'string') {
      // Vercel keeps `\n` literal when the value is pasted on one line.
      obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    }
    if (obj.private_key && obj.client_email) return obj;
  }
  throw new Error(
    'FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 JSON) with '
    + 'private_key and client_email');
}

async function getDb() {
  if (firestore) return firestore;
  if (storeError && Date.now() < retryAt) {
    throw new Error(storeError);   // stay in the fallback until the retry
  }
  const { getApps, initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const account = parseServiceAccount(rawServiceAccount());
  const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(account) });
  firestore = getFirestore(app);
  return firestore;
}

function noteOk() {
  if (storeError) {
    console.warn('[store] Firestore recovered');
    storeError = null;
  }
}

function noteError(err) {
  const message = String((err && err.message) || err || 'unknown error');
  if (message !== storeError) {
    console.error('[store] Firestore unavailable, using the memory store:', message);
  }
  storeError = message;
  retryAt = Date.now() + RETRY_MS;
  firestore = null;
}

function loadMock() {
  if (memory) return memory;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    memory = { ...EMPTY(), ...JSON.parse(raw) };
  } catch {
    memory = EMPTY();
  }
  return memory;
}

function saveMock(doc) {
  memory = doc;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(doc));
  } catch {
    // /tmp is best-effort in dev; memory still holds the value
  }
}

// Read-modify-write in ONE transaction (Firestore) or synchronously (mock).
async function mutate(fn) {
  if (firestoreActive()) {
    try {
      const db = await getDb();
      const ref = db.collection(COLLECTION).doc(DOC);
      const next = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const doc = snap.exists ? { ...EMPTY(), ...snap.data() } : EMPTY();
        const out = fn(doc) || doc;
        tx.set(ref, out);
        return out;
      });
      noteOk();
      return next;
    } catch (err) {
      noteError(err);
    }
  }
  const doc = loadMock();
  const next = fn(doc) || doc;
  saveMock(next);
  return next;
}

export async function getState() {
  if (firestoreActive()) {
    try {
      const db = await getDb();
      const snap = await db.collection(COLLECTION).doc(DOC).get();
      noteOk();
      return snap.exists ? { ...EMPTY(), ...snap.data() } : EMPTY();
    } catch (err) {
      noteError(err);
    }
  }
  return loadMock();
}

export async function setSessionState(state, extra = {}) {
  return mutate((doc) => ({
    ...doc,
    session: {
      id: extra.id || doc.session.id || null,
      state,
      ts: Date.now(),
      ...extra,
    },
  }));
}

export async function queueJob(job) {
  return mutate((doc) => ({
    ...doc,
    relay: { job: { ...job, ts: Date.now() }, answer: null },
  }));
}

export async function takeJob() {
  let taken = null;
  await mutate((doc) => {
    taken = doc.relay.job;
    return { ...doc, relay: { job: null, answer: doc.relay.answer } };
  });
  return taken;
}

export async function putAnswer(answer) {
  return mutate((doc) => ({
    ...doc,
    relay: { job: doc.relay.job, answer: { ...answer, ts: Date.now() } },
  }));
}

export async function getAnswer(id) {
  const doc = await getState();
  if (!doc.relay.answer || doc.relay.answer.id !== id) return null;
  return doc.relay.answer;
}

// Diagnostics for /api/health: never the secret itself.
export function storeStatus() {
  const configured = firestoreActive();
  return {
    configured,
    mode: firestore ? 'firestore' : (configured ? 'memory (fallback)' : 'memory'),
    error: storeError,
  };
}

// A cheap round trip used by /api/health?deep=1 to prove the store works.
export async function probe() {
  const doc = await getState();
  return { state: doc.session.state, mode: storeStatus().mode };
}

export { firestoreActive };
