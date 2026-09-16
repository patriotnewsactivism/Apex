import { useState } from 'react';

interface LoginScreenProps {
  onLogin: () => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Incorrect credentials' }));
        throw new Error(data.error || 'Login failed');
      }

      const data = (await res.json()) as { token: string };
      localStorage.setItem('apex_token', data.token);
      onLogin();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const cstTime = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background: 'var(--color-apex-bg)',
        fontFamily: 'var(--font-sans)',
        color: 'var(--color-apex-text)',
        position: 'relative',
        overflow: 'hidden',
        padding: 24,
      }}
    >
      {/* Quiet steel wash — not neon orbs */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(184,149,108,0.07), transparent 55%), radial-gradient(ellipse 60% 40% at 90% 90%, rgba(90,158,174,0.04), transparent 50%)',
          pointerEvents: 'none',
        }}
      />

      {/* Hierarchy silhouette — signature on the gate */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: '12%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(320px, 80vw)',
          opacity: 0.18,
          pointerEvents: 'none',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textAlign: 'center',
          color: 'var(--color-apex-brass)',
        }}
      >
        <div style={{ marginBottom: 8 }}>CEO</div>
        <div
          style={{
            height: 28,
            borderLeft: '1px solid var(--color-apex-brass)',
            margin: '0 auto',
            width: 0,
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            borderTop: '1px solid var(--color-apex-brass)',
            paddingTop: 8,
          }}
        >
          <span>CTO</span>
          <span>COO</span>
        </div>
      </div>

      <div
        style={{
          width: '100%',
          maxWidth: 380,
          padding: '36px 32px',
          borderRadius: 8,
          background: 'var(--color-apex-card)',
          border: '1px solid var(--color-apex-border)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1,
        }}
      >
        <div style={{ marginBottom: 28 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 6,
              background: 'var(--color-apex-brass)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 15,
              color: '#14120f',
              marginBottom: 16,
            }}
          >
            Ax
          </div>
          <h1
            className="apex-display"
            style={{
              fontSize: 28,
              margin: '0 0 6px 0',
              color: 'var(--color-apex-text)',
              letterSpacing: '0.06em',
            }}
          >
            APEX
          </h1>
          <p
            style={{
              fontSize: 13,
              color: 'var(--color-apex-muted)',
              margin: 0,
              lineHeight: 1.45,
            }}
          >
            Sign in to the workforce desk. Thirteen agents, one hierarchy.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ width: '100%' }}>
          <div style={{ marginBottom: 18 }}>
            <label
              htmlFor="password"
              className="apex-eyebrow"
              style={{ display: 'block', marginBottom: 8 }}
            >
              Admin password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              disabled={loading}
              autoComplete="current-password"
              className="apex-input"
              style={{
                borderColor: error ? 'var(--color-apex-red)' : undefined,
              }}
            />
          </div>

          {error && (
            <div
              role="alert"
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                background: 'rgba(196,92,102,0.1)',
                border: '1px solid rgba(196,92,102,0.28)',
                color: 'var(--color-apex-red)',
                fontSize: 12,
                marginBottom: 16,
                lineHeight: 1.4,
              }}
            >
              {error}. Check the password and try again.
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="btn-primary"
            style={{ width: '100%', padding: '12px 16px', fontSize: 14 }}
          >
            {loading ? 'Checking…' : 'Open desk'}
          </button>
        </form>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 24,
          fontSize: 11,
          color: 'var(--color-apex-muted)',
          fontFamily: 'var(--font-mono)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          zIndex: 1,
        }}
      >
        <div>Gate · CST {cstTime}</div>
      </div>
    </div>
  );
}
