'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// Everything goes through the cloud relay.  An HTTPS page is not allowed to
// call the board's http:// LAN address (mixed content), so a "direct" mode
// could only ever fail with ERR_CONNECTION_REFUSED.
const PRESETS = [
  { label: 'Describe what you see', prompt: 'Describe what you see in one short sentence.' },
  { label: 'What am I doing?', prompt: 'What is the person doing right now? Be specific but brief.' },
  { label: 'Expression and mood', prompt: "What is the person's expression and mood? One short sentence." },
  { label: 'Is anyone there?', prompt: 'Is anyone in the frame? If so, what are they doing? One sentence.' },
  { label: 'Watch for a wave', prompt: 'Watch for a person waving or raising a hand. Say what you see in one sentence.' },
  { label: 'Read the text', prompt: 'Read any visible text in the image. If there is none, say "no text".' },
];

const INTERVALS = [2000, 3000, 4000, 6000, 8000];

const SESSION_LABEL = {
  idle: 'voice mode',
  requested: 'switching to vision…',
  ready: 'vision ready',
  voice: 'voice mode',
  error: 'switch failed',
};

const MAX_FEED = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function CameraClient({ user }) {
  const router = useRouter();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);      // capture buffer (never displayed)
  const overlayRef = useRef(null);     // detection boxes
  const streamRef = useRef(null);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);
  const loopRef = useRef({ active: false, running: false });
  const seqRef = useRef(0);
  // Pixel size of the frame actually sent to the board. Detector boxes come
  // back in those pixels, not in the displayed video's CSS pixels.
  const frameSizeRef = useRef({ w: 0, h: 0 });
  const cfgRef = useRef({
    intervalMs: 4000,
    prompt: PRESETS[0].prompt,
    wantTts: true,
    detectKind: '',
  });

  const [session, setSession] = useState({ state: 'idle' });
  const [cameraReady, setCameraReady] = useState(false);
  const [facing, setFacing] = useState('user');
  const [live, setLive] = useState(true);
  const [intervalMs, setIntervalMs] = useState(4000);
  const [prompt, setPrompt] = useState(PRESETS[0].prompt);
  const [wantTts, setWantTts] = useState(true);
  const [detectKind, setDetectKind] = useState('');
  const [feed, setFeed] = useState([]);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ frames: 0, lastMs: null });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  // The loop reads this ref, so changing a control takes effect on the next
  // frame without restarting the loop.
  useEffect(() => {
    cfgRef.current = { intervalMs, prompt, wantTts, detectKind };
  }, [intervalMs, prompt, wantTts, detectKind]);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async (mode = 'user') => {
    stopStream();
    setCameraReady(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setFacing(mode);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setCameraReady(true);
      setError('');
    } catch (err) {
      setError(`Camera unavailable: ${err.message || err}. ` +
        'The page must be served over HTTPS (or localhost) and you must allow camera access.');
    }
  }, [stopStream]);

  // ---- session (switch the board between voice and vision) -------------
  const pollSession = useCallback(async () => {
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      setSession(data.session || { state: 'idle' });
      if (data.session?.state === 'error' && data.session?.message) {
        setError(data.session.message);
      }
    } catch {
      // a transient poll error is fine; the next tick retries
    }
  }, []);

  const startSession = useCallback(async () => {
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSession({ state: 'requested' });
      setNote('Asked the board to switch to its vision role. The first load takes about a minute.');
      pollSession();
    } catch (err) {
      setError(`Could not ask the board to switch: ${err.message || err}`);
    }
  }, [pollSession]);

  const releaseVision = useCallback(async () => {
    loopRef.current.active = false;
    try {
      await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
    } catch {
      // best effort
    }
    setSession({ state: 'idle' });
    setNote('Vision released. The board is back on the voice role.');
  }, []);

  // ---- capture + relay -------------------------------------------------
  const capture = useCallback((maxSide = 768, quality = 0.72) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) {
      throw new Error('the camera is not ready yet');
    }
    // A frame is stored in one Firestore document (1 MiB limit) and the VL
    // model does not need more pixels than this.
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    frameSizeRef.current = { w: canvas.width, h: canvas.height };
    return canvas.toDataURL('image/jpeg', quality).split(',')[1];
  }, []);

  const playWav = useCallback((b64) => {
    if (!b64) return;
    try {
      const audio = new Audio(`data:audio/wav;base64,${b64}`);
      audio.play().catch(() => {});
    } catch {
      // autoplay can be refused; the text is still shown
    }
  }, []);

  const relayVision = useCallback(async (image, cfg) => {
    const queued = await fetch('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: cfg.prompt,
        image_b64: image,
        want_tts: cfg.wantTts,
        detect_kind: cfg.detectKind || undefined,
        max_tokens: 140,
      }),
    });
    const qd = await queued.json().catch(() => ({}));
    if (!queued.ok) throw new Error(qd.error || `HTTP ${queued.status}`);
    const id = qd.id;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const res = await fetch(`/api/relay?id=${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (res.status === 204) continue;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.answer) return data.answer;
    }
    throw new Error('The board did not answer in time. Is the vision bridge running?');
  }, []);

  const drawBoxes = useCallback((detect) => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    canvas.width = video.clientWidth || 640;
    canvas.height = video.clientHeight || 360;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dets = detect?.detections || [];
    if (!dets.length) return;
    // The <video> is object-fit: cover, so it is scaled to fill and cropped.
    // Boxes are in the sent frame's pixels; map them through the same scale
    // and the crop offset so they land on the right pixels on screen.
    const frame = frameSizeRef.current;
    const srcW = Number(detect?.width) || frame.w || video.videoWidth || canvas.width;
    const srcH = Number(detect?.height) || frame.h || video.videoHeight || canvas.height;
    const scale = Math.max(canvas.width / srcW, canvas.height / srcH);
    const offX = (canvas.width - srcW * scale) / 2;
    const offY = (canvas.height - srcH * scale) / 2;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#4cc2ff';
    ctx.fillStyle = '#4cc2ff';
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    dets.forEach((d) => {
      if (!Array.isArray(d.box) || d.box.length < 4) return;
      const [x, y, w, h] = d.box;
      const dx = offX + x * scale;
      const dy = offY + y * scale;
      ctx.strokeRect(dx, dy, w * scale, h * scale);
      const label = `${d.label || 'object'}${d.score ? ` ${Math.round(d.score * 100)}%` : ''}`;
      ctx.fillText(label, dx + 4, Math.max(14, dy - 5));
    });
  }, []);

  const push = useCallback((entry) => {
    seqRef.current += 1;
    setFeed((prev) => [{
      id: seqRef.current,
      at: Date.now(),
      ...entry,
    }, ...prev].slice(0, MAX_FEED));
  }, []);

  // ---- the live loop ---------------------------------------------------
  const runLoop = useCallback(async () => {
    if (loopRef.current.running) return;
    loopRef.current.running = true;
    try {
      while (loopRef.current.active && mountedRef.current) {
        const cfg = cfgRef.current;
        if (document.hidden) {
          await sleep(1000);
          continue;
        }
        const t0 = Date.now();
        setBusy(true);
        try {
          const image = capture();
          const out = await relayVision(image, cfg);
          const ms = Date.now() - t0;
          if (!mountedRef.current) return;
          push({
            text: out.text || '(no answer)',
            detect: out.detect || null,
            ms,
            error: out.error || null,
          });
          setStats((s) => ({ frames: s.frames + 1, lastMs: ms }));
          setError(out.error || '');
          drawBoxes(out.detect);
          if (cfg.wantTts) playWav(out.wav_b64);
        } catch (err) {
          const ms = Date.now() - t0;
          if (!mountedRef.current) return;
          const message = String(err.message || err);
          setError(message);
          push({ text: message, ms, error: message });
          drawBoxes(null);
          await sleep(1500);
        } finally {
          if (mountedRef.current) setBusy(false);
        }
        // keep the cadence, but stop promptly when the user pauses
        const wait = Math.max(300, cfg.intervalMs - (Date.now() - t0));
        const until = Date.now() + wait;
        while (loopRef.current.active && Date.now() < until) {
          await sleep(200);
        }
      }
    } finally {
      loopRef.current.running = false;
    }
  }, [capture, drawBoxes, playWav, push, relayVision]);

  const startLive = useCallback(() => {
    loopRef.current.active = true;
    runLoop();
  }, [runLoop]);

  const stopLive = useCallback(() => {
    loopRef.current.active = false;
  }, []);

  const state = session?.state || 'idle';
  const watching = live && state === 'ready' && cameraReady;

  useEffect(() => {
    if (watching) startLive();
    else stopLive();
  }, [watching, startLive, stopLive]);

  // ---- lifecycle -------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    try {
      const savedInterval = Number(localStorage.getItem('ventuno.intervalMs'));
      if (INTERVALS.includes(savedInterval)) setIntervalMs(savedInterval);
      const savedPrompt = localStorage.getItem('ventuno.prompt');
      if (savedPrompt) setPrompt(savedPrompt);
      const savedDetect = localStorage.getItem('ventuno.detectKind');
      if (['face', 'object'].includes(savedDetect)) setDetectKind(savedDetect);
    } catch {
      // localStorage can be disabled; defaults are fine
    }
    startCamera('user');
    startSession();
    pollRef.current = setInterval(pollSession, 4000);

    const release = () => {
      try {
        fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
          keepalive: true,
        });
      } catch {
        // best effort
      }
    };
    window.addEventListener('pagehide', release);
    return () => {
      mountedRef.current = false;
      loopRef.current.active = false;
      window.removeEventListener('pagehide', release);
      if (pollRef.current) clearInterval(pollRef.current);
      stopStream();
      release();
    };
  }, [pollSession, startCamera, startSession, stopStream]);

  useEffect(() => {
    try {
      localStorage.setItem('ventuno.intervalMs', String(intervalMs));
      localStorage.setItem('ventuno.prompt', prompt);
      localStorage.setItem('ventuno.detectKind', detectKind);
    } catch {
      // ignore
    }
  }, [intervalMs, prompt, detectKind]);

  function flipCamera() {
    startCamera(facing === 'user' ? 'environment' : 'user');
  }

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    router.replace('/');
  }

  const latest = feed[0];
  const detectionCounts = (detect) => {
    const counts = {};
    (detect?.detections || []).forEach((d) => {
      const key = d.label || 'object';
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts);
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo">V</div>
          <div>
            <h1>Ventuno Vision</h1>
            <div className="muted small">signed in as {user}</div>
          </div>
        </div>
        <div className="row">
          <span className={`badge ${state}`}>
            <span className="dot" />
            {SESSION_LABEL[state] || state}
          </span>
          <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
            Settings
          </button>
          <button className="ghost" onClick={releaseVision}>Release vision</button>
          <button className="ghost" onClick={logout}>Sign out</button>
        </div>
      </header>

      {showSettings ? (
        <div className="card stack" style={{ marginBottom: '1rem' }}>
          <strong>Live settings</strong>
          <div className="row">
            <label className="stack small grow" style={{ gap: '0.3rem' }}>
              <span className="muted">Frame interval</span>
              <select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))}>
                {INTERVALS.map((ms) => (
                  <option key={ms} value={ms}>every {ms / 1000}s</option>
                ))}
              </select>
            </label>
            <label className="stack small grow" style={{ gap: '0.3rem' }}>
              <span className="muted">Detection</span>
              <select value={detectKind} onChange={(e) => setDetectKind(e.target.value)}>
                <option value="">off</option>
                <option value="face">faces</option>
                <option value="object">objects</option>
              </select>
            </label>
            <label className="row small" style={{ gap: '0.4rem' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={wantTts}
                onChange={(e) => setWantTts(e.target.checked)} />
              speak the answer
            </label>
          </div>
          <div className="small muted">
            Connection: cloud relay. The page is HTTPS and the board is on your
            LAN over HTTP, so the browser may not call the board directly. The
            board fetches each frame from here, runs the model locally, and posts
            the answer back.
          </div>
          <div className="row">
            <button className="primary" onClick={() => setShowSettings(false)}>Done</button>
          </div>
        </div>
      ) : null}

      <div className="grid">
        <section className="card stack">
          <div className="video-box">
            <video ref={videoRef} playsInline muted autoPlay />
            <canvas ref={overlayRef} className="overlay" />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            <div className={`live-pill ${watching ? 'on' : ''}`}>
              <span className="dot" />
              {watching ? (busy ? 'looking…' : 'live') : live ? 'waiting' : 'paused'}
            </div>
            <div className={`caption ${latest?.text ? '' : 'empty'}`}>
              {latest?.text || (state === 'requested'
                ? 'Switching the board to its vision role… the first load takes about a minute.'
                : 'Start watching to see live commentary.')}
            </div>
            {!cameraReady ? (
              <div className="video-empty">
                Starting the camera…
                <br />
                <span className="small">Allow camera access when the browser asks.</span>
              </div>
            ) : null}
          </div>

          <div className="row">
            <button className={`primary ${watching ? 'stop' : ''}`}
              onClick={() => setLive((v) => !v)}
              disabled={!cameraReady || state === 'requested'}>
              {watching ? 'Pause live' : 'Start watching'}
            </button>
            <button className="ghost" onClick={flipCamera} disabled={!cameraReady}>
              Flip camera
            </button>
            <span className="grow" />
            <span className="small muted">
              {stats.frames} frames{stats.lastMs ? ` · last ${(stats.lastMs / 1000).toFixed(1)}s` : ''}
            </span>
          </div>

          <div className="row">
            <select className="grow" value={prompt}
              onChange={(e) => setPrompt(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.prompt} value={p.prompt}>{p.label}</option>
              ))}
              {!PRESETS.some((p) => p.prompt === prompt) ? (
                <option value={prompt}>custom</option>
              ) : null}
            </select>
            <input className="grow" value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should Ventuno watch for?" />
          </div>

          <div className="row small muted">
            <span>Every {intervalMs / 1000}s</span>
            <span>·</span>
            <span>{detectKind ? `${detectKind} detection on` : 'detection off'}</span>
            <span>·</span>
            <span>{wantTts ? 'speaking' : 'muted'}</span>
          </div>
        </section>

        <aside className="stack">
          <div className="card stack">
            <div className="row">
              <strong>Live feed</strong>
              <span className="grow" />
              <span className="small muted">{feed.length ? `${feed.length} observations` : ''}</span>
            </div>
            {feed.length === 0 ? (
              <div className="answer empty">
                Nothing yet. Once the board is on the vision role, every frame
                is described here automatically.
              </div>
            ) : (
              <div className="feed">
                {feed.map((item) => (
                  <div key={item.id} className={`feed-item ${item.error ? 'bad' : ''}`}>
                    <div className="row small muted">
                      <span>{new Date(item.at).toLocaleTimeString()}</span>
                      <span>·</span>
                      <span>{(item.ms / 1000).toFixed(1)}s</span>
                      {item.detect ? (
                        <>
                          <span>·</span>
                          <span className="chips">
                            {detectionCounts(item.detect).map(([k, v]) => (
                              <span className="chip" key={k}>{k} ×{v}</span>
                            ))}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <div>{item.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {note ? <div className="hint">{note}</div> : null}
          {error ? <div className="hint error">{error}</div> : null}

          <div className="card small muted stack" style={{ gap: '0.5rem' }}>
            <strong style={{ color: 'var(--text)' }}>How live works</strong>
            <div>
              The camera stays on. Every {intervalMs / 1000}s the newest frame is
              relayed to the board, described by the Qwen VL model, and the answer
              is spoken and added to the feed. Detection runs on the same frame.
            </div>
            <div>
              The model needs a few seconds per frame, so this is live awareness
              (a new observation every few seconds), not 30 fps video.
            </div>
            <div>
              Voice and vision are the same resident model: switching is a role
              change, not a reload.
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
