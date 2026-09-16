import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon, Copy } from 'lucide-react';
import { copyText } from '../lib/clipboard.js';

/**
 * Keeps one panel's crash from blanking the whole dashboard.
 *
 * React unmounts the entire tree on an uncaught render error, so before this
 * a single bad field access in any panel left a white screen with the reason
 * only in the console — the least diagnosable failure the app can produce, and
 * the one most likely to happen exactly when something else is already wrong.
 * The stack is rendered and copyable, because "the dashboard went white" is not
 * a bug report and this is what turns it into one.
 */
interface Props {
  /** Shown in the fallback so the operator knows which panel died. */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: `${error.stack ?? error.message}\n${info.componentStack ?? ''}`.trim() });
    console.error(`[${this.props.name}] panel crashed`, error, info);
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const report = `APEX panel crash — ${this.props.name}\n${new Date().toISOString()}\n\n${stack || error.message}`;

    return (
      <div
        className="glass-card"
        style={{
          border: '1px solid rgba(239, 68, 68, 0.35)',
          background: 'rgba(239, 68, 68, 0.08)',
          padding: 16,
          margin: '12px 0',
          maxWidth: '100%',
          minWidth: 0,
        }}
      >
        <div className="apex-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertOctagon size={16} color="#ef4444" />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>
            {this.props.name} failed to render
          </span>
          <div style={{ flex: 1, minWidth: 0 }} />
          <button
            className="btn-secondary apex-tap"
            onClick={() => copyText(report)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }}
          >
            <Copy size={13} /> Copy error
          </button>
        </div>
        <div style={{ fontSize: 12, color: '#fca5a5', marginTop: 8, overflowWrap: 'anywhere' }}>
          {error.message}
        </div>
        <button
          className="btn-secondary apex-tap"
          onClick={() => this.setState({ error: null, stack: '' })}
          style={{ marginTop: 10, padding: '6px 12px', fontSize: 12 }}
        >
          Retry
        </button>
        {stack && (
          <pre
            className="apex-scroll-x"
            style={{
              marginTop: 10,
              fontSize: 10,
              lineHeight: 1.5,
              color: '#94a3b8',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 220,
              overflowY: 'auto',
              maxWidth: '100%',
            }}
          >
            {stack}
          </pre>
        )}
      </div>
    );
  }
}
