# Ventuno Vision webapp

A login-gated camera console for the **Ventuno Q** desk assistant, hosted on
Vercel. Signing in tells the board to switch from the voice role to the
vision role; the page then shows the camera and answers questions about what
it sees.

The important design point: **voice and vision are the same resident model**
(`genie:qwen3_vl_4b_instruct`). A switch is a role change inside the app, not
an unload/reload, so it costs no NPU memory and cannot leak the CDSP dma-buf.
The board keeps whisper (ASR) and melo (TTS) up the whole time.

## How the two sides talk

```
  browser (HTTPS)                Vercel (this app)                 Ventuno Q
  ───────────────                ─────────────────                 ─────────
  login  ──────────────────────► /api/login  (username + PIN)
  open camera ─────────────────► /api/session {action:"start"}
                                       │  state = "requested"
                                       ▼
                                 /api/session  ◄──────────────  vision_session.py polls
                                       │                         (every 2 s, X-Api-Key)
                                       │                         switches role to vision
                                 state = "ready"  ◄───────────  reports "ready"
  Ask Ventuno ─────────────────► direct to the board (low latency)
        │                              or
        └────────────────────────► /api/relay  ◄──────────────  board fetches the frame,
                                       │                         runs the VL model locally,
                                 answer  ──────────────────────► posts text (+ WAV)
```

The board is the only side that touches the NPU. The web UI never loads or
unloads a model; it only asks for the vision role.

## Quick start (local)

```bash
cp .env.example .env.local        # set WEB_USERNAME, WEB_PIN, SESSION_SECRET, SYNC_API_KEY
npm install
npm run dev                       # http://localhost:3000
```

Without `FIREBASE_SERVICE_ACCOUNT` the app uses an in-memory + `/tmp` store.
That is fine for local development; on Vercel use Firestore (below) so the
session and relay state survive between serverless invocations.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Vercel → **New Project** → import the repo (Next.js is auto-detected).
3. Project → Settings → Environment Variables:
   - `WEB_USERNAME` — the login name.
   - `WEB_PIN` — the PIN.
   - `SESSION_SECRET` — a long random string (`openssl rand -hex 32`).
   - `SYNC_API_KEY` — the key the board sends as `X-Api-Key`.
   - `FIREBASE_SERVICE_ACCOUNT` — optional but recommended: the full JSON of
     a Firebase service-account key, on one line. Enables Firestore.
   - `NEXT_PUBLIC_BOARD_URL` — optional default board URL, e.g.
     `http://192.168.29.35:8090`.
4. Deploy. The UI is at the root, the API under `/api/*`.

Firestore touches exactly one document, `vision/main`, from the server only,
so the default locked-down rules work.

## Connect the board

On the Ventuno Q:

```bash
cat > ~/ventuno/data/vision_webapp.json <<'JSON'
{ "url": "https://your-app.vercel.app", "key": "the-same-SYNC_API_KEY" }
JSON

# one poll, to test
~/ventuno/venv/bin/python ~/ventuno/bin/vision_session.py status
~/ventuno/venv/bin/python ~/ventuno/bin/vision_session.py once

# run it as a service
sudo cp ~/ventuno/systemd/ventuno-vision.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ventuno-vision
```

The bridge **waits** when the config file is absent (the unit can be enabled
before the webapp is hosted, so it does not restart-loop). Once the file
appears it polls `/api/session`, switches the role, and serves relayed frames.

## Direct mode vs relay mode

| | direct | relay |
|---|---|---|
| path | browser → board `:8090` | browser → Vercel → board |
| latency | ~2–8 s per question | +1–3 s of polling |
| needs | board reachable from the browser | board can reach Vercel (outbound) |
| works on Vercel over HTTPS with an HTTP board | **no** (mixed content) | **yes** |

Browsers block an HTTPS page from calling an `http://192.168.x.x` address.
`Auto` mode detects that and uses the relay. Direct mode works when:

- the page is served over HTTP (local dev), or
- the board is reached through an HTTPS tunnel, or
- the board URL is `localhost` / `127.0.0.1`.

Set the mode and board URL in the page's **Settings** panel; they are saved in
`localStorage`.

## API (all JSON)

| route | who | purpose |
|---|---|---|
| `POST /api/login` | browser | `{username, pin}` → signed HttpOnly cookie |
| `POST /api/logout` | browser | clear the cookie |
| `GET /api/session` | board / browser | current `{session, relay}` |
| `POST /api/session` | browser | `{action:"start"\|"stop"}` |
| `POST /api/session` | board | `{action:"ready"\|"voice"\|"error"}` |
| `POST /api/relay` | browser | `{prompt, image_b64, want_tts}` → `{id}` |
| `GET /api/relay?id=` | browser | `200 {answer}` or `204` |
| `GET /api/relay?job=1` | board | next frame to analyse |
| `POST /api/relay` | board | `{id, text, wav_b64?, error?}` |
| `GET /api/health` | anyone | liveness + which secrets are configured |

The board authenticates with `X-Api-Key: $SYNC_API_KEY`; the browser with the
signed cookie.

## Security notes

- **Fail closed.** If `SYNC_API_KEY` is unset, nobody is treated as the board.
  If `SESSION_SECRET` or the username/PIN are unset in production, login
  refuses with a clear error instead of falling back to the development
  defaults. `GET /api/health` shows which secrets are present (never values).
- The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production,
  and expires after 24 h.
- Login failures are rate-limited: 5 wrong PINs per client IP per 5 minutes
  → `429`. The counter is per serverless instance, so it is a speed bump, not
  a global lock. Use a longer PIN than 4 digits.
- `SYNC_API_KEY` and `SESSION_SECRET` should be different long random strings
  (`openssl rand -hex 32`).

## Privacy

- Frames are uploaded only when you press **Ask Ventuno** (relay mode) and are
  cleared as soon as the board takes them.
- Analysis runs on the board's NPU. Nothing is sent to an inference API.
- The webapp stores one small state document (session state + one pending
  frame/answer), not a history.

## Local protocol test

The browser/board contract is covered by a dependency-free script:

```bash
npm run build && npm start          # with the four required env vars
node test/session-protocol.js http://127.0.0.1:3000
```

It checks login (wrong/right PIN), the signed cookie, anonymous access,
`requested → ready → idle`, the relay (queue → take once → answer), the
board key, and the login rate limit (22 checks). The rate-limit check runs
last because it locks the client IP for five minutes.

## Troubleshooting

- **"switching to vision…" never becomes "vision ready"** — the board bridge
  is not running or cannot reach the URL. Check
  `vision_session.py status` and `systemctl status ventuno-vision`.
- **Direct call failed / mixed content** — switch to `relay` (or use an HTTPS
  tunnel for the board).
- **Camera unavailable** — the page must be HTTPS or localhost, and camera
  permission must be granted.
- **"vision is not loaded"** — the board is on the voice role; press
  **Release vision** and re-open the page, or check the bridge.
