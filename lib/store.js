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
// ============================================================

import fs from 'fs';

const STATE_FILE = process.env.VENTUNO_VISION_STATE || '/tmp/ventuno-vision.json';

const EMPTY = () => ({
  session: { id: null, state: 'idle', ts: 0 },
  relay: { job: null, answer: null },
});

let memory = null;
let firestore = null;

function firestoreActive() {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT;
}

async function getDb() {
  if (firestore) return firestore;
  // firebase-admin >= 12 uses the modular entry points; the legacy
  // `admin.firestore()` / `admin.credential` namespace was removed in v14.
  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(cred) });
  firestore = getFirestore(app);
  return firestore;
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
    const db = await getDb();
    const ref = db.collection('vision').doc('main');
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const doc = snap.exists ? { ...EMPTY(), ...snap.data() } : EMPTY();
      const next = fn(doc) || doc;
      tx.set(ref, next);
      return next;
    });
  }
  const doc = loadMock();
  const next = fn(doc) || doc;
  saveMock(next);
  return next;
}

export async function getState() {
  if (firestoreActive()) {
    const db = await getDb();
    const snap = await db.collection('vision').doc('main').get();
    return snap.exists ? { ...EMPTY(), ...snap.data() } : EMPTY();
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

export { firestoreActive };
