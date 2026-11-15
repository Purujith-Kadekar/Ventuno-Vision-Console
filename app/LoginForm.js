'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.replace('/camera');
      router.refresh();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="card login-card stack" onSubmit={submit}>
        <div className="logo">V</div>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.35rem' }}>Ventuno Vision</h1>
          <p className="muted small" style={{ margin: '0.35rem 0 0' }}>
            Sign in to open the camera. The Ventuno Q switches to its vision
            role as soon as you are in.
          </p>
        </div>
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="small muted">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)}
            autoComplete="username" autoFocus required />
        </label>
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="small muted">PIN</span>
          <input value={pin} onChange={(e) => setPin(e.target.value)}
            type="password" inputMode="numeric" autoComplete="current-password"
            required />
        </label>
        {error ? <div className="hint error">{error}</div> : null}
        <button className="primary" disabled={busy || !username || !pin}>
          {busy ? 'Signing in…' : 'Open camera'}
        </button>
        <p className="muted small" style={{ margin: 0 }}>
          Private by design: frames go to your board, not to this site.
        </p>
      </form>
    </main>
  );
}
