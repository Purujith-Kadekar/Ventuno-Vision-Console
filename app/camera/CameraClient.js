'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_BOARD = process.env.NEXT_PUBLIC_BOARD_URL || 'http://192.168.29.35:8090';
const SESSION_LABEL = {
  idle: 'voice mode',
  requested: 'switching to vision…',
  ready: 'vision ready',
  voice: 'voice mode',
  error: 'switch failed',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function CameraClient({ user }) {
  const router = useRouter();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  const [boardUrl, setBoardUrl] = useState(DEFAULT_BOARD);
  const [mode, setMode] = useState('auto');
  const [session, setSession] = useState({ state: 'idle' });
  const [cameraReady, setCameraReady] = useState(false);
  const [prompt, setPrompt] = useState('What do you see?');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [wantTts, setWantTts] = useState(true);
  const [detectKind, setDetectKind] = useState('');
  const [detection, setDetection] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollSession = useCallback(async () => {
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      setSession(data.session || { state: 'idle' });
      if (['ready', 'error', 'voice'].includes(data.session?.state)) {
        stopPolling();
      }
    } catch {
      // a transient poll error is fine; the next tick retries
    }
  }, [stopPolling]);

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
      stopPolling();
      pollRef.current = setInterval(pollSession, 2000);
      pollSession();
    } catch (err) {
      setError(`Could not ask the board to switch: ${err.message || err}`);
    }
  }, [pollSession, stopPolling]);

  const releaseVision = useCallback(async () => {
    stopPolling();
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
  }, [stopPolling]);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
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
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    try {
      const savedUrl = localStorage.getItem('ventuno.boardUrl');
      if (savedUrl) setBoardUrl(savedUrl);
      const savedMode = localStorage.getItem('ventuno.mode');
      if (savedMode) setMode(savedMode);
    } catch {
      // localStorage can be disabled; defaults are fine
    }
    startCamera();
    startSession();

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
      window.removeEventListener('pagehide', release);
      stopPolling();
      stopStream();
      release();
    };
  }, [startCamera, startSession, stopPolling, stopStream]);

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) {
      throw new Error('the camera is not ready yet');
    }
    // Cap the longest side: a relayed frame is stored in one Firestore
    // document (1 MiB limit), and the VL model does not need more pixels.
    const MAX_SIDE = 1024;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  }

  function directBlocked() {
    if (typeof window === 'undefined') return false;
    const httpsBoard = /^https:\/\//i.test(boardUrl);
    const localBoard = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(boardUrl);
    return window.isSecureContext && !httpsBoard && !localBoard;
  }

  function playWav(b64) {
    if (!b64) return;
    try {
      const audio = new Audio(`data:audio/wav;base64,${b64}`);
      audio.play().catch(() => {});
    } catch {
      // autoplay can be refused; the text answer is still shown
    }
  }

  async function directVision(image) {
    const base = boardUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        images: [image],
        max_tokens: 220,
        temperature: 0.2,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    let wav = null;
    if (wantTts && data.text) {
      try {
        const t = await fetch(`${base}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: data.text }),
        });
        if (t.ok) wav = (await t.json()).wav_b64;
      } catch {
        // speech is optional
      }
    }
    return { text: data.text, wav_b64: wav };
  }

  async function relayVision(image) {
    const queued = await fetch('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image_b64: image, want_tts: wantTts }),
    });
    const qd = await queued.json().catch(() => ({}));
    if (!queued.ok) throw new Error(qd.error || `HTTP ${queued.status}`);
    const id = qd.id;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const res = await fetch(`/api/relay?id=${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (res.status === 204) continue;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.answer) return data.answer;
    }
    throw new Error('The board did not answer in time. Is the vision bridge ' +
      '(vision_session.py) running on the board?');
  }

  async function ask() {
    setBusy(true);
    setError('');
    setNote('');
    setAnswer('');
    setDetection(null);
    try {
      const image = capture();
      const useDirect = mode === 'direct' || (mode === 'auto' && !directBlocked());
      if (useDirect) {
        try {
          const out = await directVision(image);
          setAnswer(out.text || '(no answer)');
          playWav(out.wav_b64);
          return;
        } catch (err) {
          setNote(`Direct call failed (${err.message}). Trying the cloud relay…`);
        }
      } else if (mode === 'auto') {
        setNote('The browser blocks an HTTPS page from calling the HTTP board ' +
          'directly, so this frame goes through the cloud relay.');
      }
      const out = await relayVision(image);
      setAnswer(out.text || '(no answer)');
      if (out.error) setError(out.error);
      playWav(out.wav_b64);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function runDetector() {
    setError('');
    setDetection(null);
    try {
      const image = capture();
      const base = boardUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: detectKind,
          image_b64: image,
          image_type: 'jpeg',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetection(data);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem('ventuno.boardUrl', boardUrl.trim());
      localStorage.setItem('ventuno.mode', mode);
    } catch {
      // ignore
    }
    setShowSettings(false);
  }

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    router.replace('/');
  }

  const state = session?.state || 'idle';
  const modeLabel = mode === 'relay' ? 'cloud relay' : mode === 'direct' ? 'direct' : 'auto';

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
          <strong>Connection</strong>
          <label className="stack small" style={{ gap: '0.3rem' }}>
            <span className="muted">Board URL</span>
            <input value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)}
              placeholder="http://192.168.29.35:8090 or an HTTPS tunnel" />
          </label>
          <label className="stack small" style={{ gap: '0.3rem' }}>
            <span className="muted">Mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="auto">Auto — direct if possible, else relay</option>
              <option value="direct">Direct to the board — lowest latency</option>
              <option value="relay">Cloud relay — works from anywhere</option>
            </select>
          </label>
          <div className="row">
            <button className="primary" onClick={saveSettings}>Save</button>
            <button className="ghost" onClick={() => setShowSettings(false)}>Close</button>
          </div>
          <div className="small muted">
            Direct mode needs the board on the same network (or an HTTPS tunnel).
            An HTTPS page cannot call an HTTP LAN address, so Auto uses the relay
            for that case.
          </div>
        </div>
      ) : null}

      <div className="grid">
        <section className="card stack">
          <div className="video-box">
            <video ref={videoRef} playsInline muted autoPlay />
            <canvas ref={canvasRef} />
            {!cameraReady ? (
              <div className="video-empty">
                Starting the camera…
                <br />
                <span className="small">Allow camera access when the browser asks.</span>
              </div>
            ) : null}
          </div>

          <div className="row">
            <input className="grow" value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask about the picture…" />
            <button className="primary" disabled={busy || !cameraReady} onClick={ask}>
              {busy ? 'Looking…' : 'Ask Ventuno'}
            </button>
          </div>

          <div className="row small muted">
            <label className="row" style={{ gap: '0.4rem' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={wantTts}
                onChange={(e) => setWantTts(e.target.checked)} />
              speak the answer
            </label>
            <select style={{ width: 'auto' }} value={detectKind}
              onChange={(e) => setDetectKind(e.target.value)}>
              <option value="">detectors off</option>
              <option value="face">face detection</option>
              <option value="object">object detection</option>
            </select>
            <button className="ghost" disabled={!detectKind || !cameraReady}
              onClick={runDetector}>
              Run detector
            </button>
          </div>
        </section>

        <aside className="stack">
          <div className="card stack">
            <div className="row">
              <strong>Answer</strong>
              <span className="grow" />
              <span className="small muted">{modeLabel}</span>
            </div>
            <div className={`answer ${answer ? '' : 'empty'}`}>
              {answer || 'Ask a question about what the camera sees.'}
            </div>
          </div>

          {detection ? (
            <div className="card stack">
              <strong>Detector</strong>
              <pre className="json">{JSON.stringify(detection, null, 2)}</pre>
            </div>
          ) : null}

          {note ? <div className="hint">{note}</div> : null}
          {error ? <div className="hint error">{error}</div> : null}

          <div className="card small muted stack" style={{ gap: '0.5rem' }}>
            <strong style={{ color: 'var(--text)' }}>How it works</strong>
            <div>
              Signing in asks the board to switch to its vision role. Voice and
              vision are the same resident Qwen VL model, so the switch is a role
              change — no reload and no NPU memory churn.
            </div>
            <div>
              In relay mode the frame is uploaded here, the board fetches it,
              answers locally, and posts the answer back. Nothing is analysed in
              the cloud.
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
