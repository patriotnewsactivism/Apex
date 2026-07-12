import { useState } from 'react';
import { Brain } from 'lucide-react';

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

      const data = await res.json() as { token: string };
      localStorage.setItem('apex_token', data.token);
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
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
        background: '#07080d',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
        color: 'white',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background glow effects */}
      <div
        style={{
          position: 'absolute',
          width: '400px',
          height: '400px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(0,229,255,0.05) 0%, transparent 70%)',
          top: '10%',
          left: '10%',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: '500px',
          height: '500px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(184,76,255,0.03) 0%, transparent 70%)',
          bottom: '10%',
          right: '10%',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          width: '100%',
          maxWidth: '400px',
          padding: '40px 32px',
          borderRadius: '16px',
          background: 'rgba(13,17,23,0.8)',
          border: '1px solid rgba(0,229,255,0.1)',
          backdropFilter: 'blur(16px)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 40px rgba(0,229,255,0.02)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          zIndex: 1,
        }}
      >
        {/* Logo/Icon */}
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: 'linear-gradient(135deg, #00e5ff, #b84cff)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 30px rgba(0,229,255,0.25)',
            marginBottom: '24px',
          }}
        >
          <Brain size={30} color="#000" />
        </div>

        <h1
          style={{
            fontSize: '24px',
            fontWeight: 800,
            letterSpacing: '0.08em',
            margin: '0 0 4px 0',
            textAlign: 'center',
            background: 'linear-gradient(to right, #ffffff, #a5b4fc)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          APEX
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: 'rgba(255,255,255,0.5)',
            margin: '0 0 32px 0',
            textAlign: 'center',
            letterSpacing: '0.04em',
          }}
        >
          AI Workforce Command Center
        </p>

        <form onSubmit={handleSubmit} style={{ width: '100%' }}>
          <div style={{ marginBottom: '20px' }}>
            <label
              htmlFor="password"
              style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'rgba(255,255,255,0.4)',
                marginBottom: '8px',
              }}
            >
              Command Authorization Key
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: '8px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(0,229,255,0.15)',
                color: 'white',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.2s, box-shadow 0.2s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = '#00e5ff';
                e.currentTarget.style.boxShadow = '0 0 10px rgba(0,229,255,0.15)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(0,229,255,0.15)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>

          {error && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '6px',
                background: 'rgba(255,59,92,0.1)',
                border: '1px solid rgba(255,59,92,0.2)',
                color: '#ff3b5c',
                fontSize: '12px',
                marginBottom: '20px',
                textAlign: 'center',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: '8px',
              border: 'none',
              background: '#00e5ff',
              color: '#000',
              fontWeight: 700,
              fontSize: '14px',
              cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: '0 0 20px rgba(0,229,255,0.3)',
              transition: 'transform 0.1s, opacity 0.2s, box-shadow 0.2s',
              opacity: loading ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!loading) e.currentTarget.style.boxShadow = '0 0 25px rgba(0,229,255,0.5)';
            }}
            onMouseLeave={(e) => {
              if (!loading) e.currentTarget.style.boxShadow = '0 0 20px rgba(0,229,255,0.3)';
            }}
          >
            {loading ? 'Authorizing...' : 'Enter Command Center'}
          </button>
        </form>
      </div>

      {/* Footer */}
      <div
        style={{
          position: 'absolute',
          bottom: '24px',
          fontSize: '11px',
          color: 'rgba(255,255,255,0.3)',
          fontFamily: 'var(--font-mono, monospace)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '4px',
          zIndex: 1,
        }}
      >
        <div>APEX SECURITY GATE v1.0.0</div>
        <div>SYSTEM TIME: {cstTime} CST</div>
      </div>
    </div>
  );
}
