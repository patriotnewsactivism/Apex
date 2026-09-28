import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Copy,
  ExternalLink,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Radio,
  SkipBack,
  SkipForward,
  Square,
  Users,
} from 'lucide-react';
import { api, type WebinarAdminDashboard, type WebinarAdminSession } from '../lib/api.js';

export function WebinarDirector() {
  const [sessions, setSessions] = useState<WebinarAdminSession[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [dashboard, setDashboard] = useState<WebinarAdminDashboard | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [hostMessage, setHostMessage] = useState('');
  const [copied, setCopied] = useState(false);

  const refreshList = useCallback(async () => {
    const next = await api.webinars.list();
    setSessions(next);
    if (!selectedId && next[0]) setSelectedId(next[0].id);
    return next;
  }, [selectedId]);

  const refreshDashboard = useCallback(async () => {
    if (!selectedId) {
      setDashboard(null);
      return;
    }
    try {
      setDashboard(await api.webinars.dashboard(selectedId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId]);

  useEffect(() => {
    void refreshList().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [refreshList]);

  useEffect(() => {
    void refreshDashboard();
    if (!selectedId) return;
    const timer = window.setInterval(() => {
      void refreshDashboard();
      void refreshList();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [selectedId, refreshDashboard, refreshList]);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError('');
    try {
      await fn();
      await Promise.all([refreshDashboard(), refreshList()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const createToday = async () => {
    await run('create', async () => {
      const session = await api.webinars.create({
        title: 'The AI Workforce: APEX + BuildMyBot Live',
        mode: 'autonomous',
        ctaLabel: 'Explore BuildMyBot.app',
        ctaUrl: 'https://buildmybot.app',
      });
      setSelectedId(session.id);
    });
  };

  const session = dashboard?.session ?? sessions.find((item) => item.id === selectedId) ?? null;
  const segmentIndex = session?.current_segment ?? 0;
  const segments = dashboard?.segments ?? [];
  const publicUrl = session ? `${window.location.origin}/webinar/${session.slug}` : '';
  const liveAttendees = dashboard?.attendees.filter((a) => Date.now() - new Date(a.last_seen_at).getTime() < 120000).length ?? 0;
  const hotAttendees = dashboard?.attendees.filter((a) => a.engagement_score >= 25).length ?? 0;

  const statusTone = useMemo(() => {
    if (!session) return 'var(--color-apex-muted)';
    if (session.status === 'live') return 'var(--color-apex-green)';
    if (session.status === 'paused') return 'var(--color-apex-orange)';
    if (session.status === 'ended') return 'var(--color-apex-red)';
    return 'var(--color-apex-muted)';
  }, [session]);

  const copyRoom = async () => {
    if (!publicUrl) return;
    await navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const sendHostMessage = async () => {
    if (!session || !hostMessage.trim()) return;
    const message = hostMessage.trim();
    setHostMessage('');
    await run('message', () => api.webinars.message(session.id, message));
  };

  const card: React.CSSProperties = {
    background: 'var(--color-apex-surface)',
    border: '1px solid var(--color-apex-line)',
    borderRadius: 10,
  };

  if (!session && sessions.length === 0) {
    return (
      <div style={{ ...card, padding: 32, maxWidth: 760 }}>
        <div className="apex-eyebrow" style={{ marginBottom: 10 }}>Revenue · Live events</div>
        <h2 className="apex-display" style={{ margin: 0, fontSize: 28 }}>Build today’s autonomous webinar room</h2>
        <p style={{ color: 'var(--color-apex-muted)', lineHeight: 1.65, maxWidth: 620 }}>
          This creates the public attendee room, AI narration, live Q&A, lead capture,
          engagement scoring, CTA tracking, and your operator takeover controls.
        </p>
        <button onClick={() => void createToday()} disabled={busy === 'create'} style={primaryButton}>
          <Plus size={16} /> {busy === 'create' ? 'Creating…' : 'Create today’s webinar'}
        </button>
        {error && <div style={{ color: 'var(--color-apex-red)', marginTop: 14 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ ...card, padding: 18 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="apex-eyebrow" style={{ marginBottom: 6 }}>Webinar Director</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <h2 className="apex-display" style={{ margin: 0, fontSize: 24 }}>{session?.title}</h2>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: statusTone, border: `1px solid ${statusTone}`, padding: '4px 7px', borderRadius: 999 }}>
                {session?.status}
              </span>
            </div>
          </div>
          <button onClick={() => void createToday()} style={secondaryButton}><Plus size={15} /> New room</button>
        </div>

        {sessions.length > 1 && (
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ marginTop: 14, background: 'var(--color-apex-bg)', color: 'var(--color-apex-text)', border: '1px solid var(--color-apex-line)', borderRadius: 6, padding: '9px 10px', minWidth: 280 }}
          >
            {sessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.status}</option>)}
          </select>
        )}

        {publicUrl && (
          <div style={{ marginTop: 16, padding: 12, borderRadius: 7, background: 'rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Radio size={15} color="var(--color-apex-brass)" />
            <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-apex-muted)', fontSize: 11 }}>{publicUrl}</code>
            <button onClick={() => void copyRoom()} style={iconButton} title="Copy attendee link"><Copy size={15} /></button>
            <button onClick={() => window.open(publicUrl, '_blank', 'noopener,noreferrer')} style={iconButton} title="Open attendee room"><ExternalLink size={15} /></button>
          </div>
        )}
        {copied && <div style={{ color: 'var(--color-apex-green)', fontSize: 11, marginTop: 6 }}>Attendee link copied.</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(290px, 0.65fr)', gap: 18 }}>
        <section style={{ display: 'grid', gap: 18 }}>
          <div style={{ ...card, padding: 20 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              {session?.status === 'draft' && (
                <button onClick={() => void run('start', () => api.webinars.start(session.id))} disabled={Boolean(busy)} style={primaryButton}><Play size={16} /> Go live now</button>
              )}
              {session?.status === 'live' && (
                <button onClick={() => void run('pause', () => api.webinars.pause(session.id))} disabled={Boolean(busy)} style={warningButton}><Pause size={16} /> Take the floor</button>
              )}
              {session?.status === 'paused' && (
                <button onClick={() => void run('resume', () => api.webinars.resume(session.id))} disabled={Boolean(busy)} style={primaryButton}><Play size={16} /> Return to AI host</button>
              )}
              {session && session.status !== 'ended' && (
                <button onClick={() => void run('end', () => api.webinars.end(session.id))} disabled={Boolean(busy)} style={dangerButton}><Square size={15} /> End webinar</button>
              )}
              {session && (
                <button
                  onClick={() => void run('mode', () => api.webinars.mode(session.id, !session.autonomous))}
                  disabled={Boolean(busy)}
                  style={secondaryButton}
                >
                  <Bot size={15} /> {session.autonomous ? 'Autonomous on' : 'Cohost mode'}
                </button>
              )}
            </div>

            <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
              <Metric label="Live" value={liveAttendees} />
              <Metric label="Registered" value={dashboard?.attendees.length ?? session?.attendee_count ?? 0} />
              <Metric label="Questions" value={dashboard?.questions.length ?? session?.question_count ?? 0} />
              <Metric label="High intent" value={hotAttendees} />
            </div>
          </div>

          <div style={{ ...card, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div className="apex-eyebrow">Now presenting</div>
                <h3 style={{ margin: '6px 0 0', fontSize: 20 }}>
                  {segments[segmentIndex]?.title ?? 'Preparing room'}
                </h3>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  disabled={!session || segmentIndex <= 0 || Boolean(busy)}
                  onClick={() => session && void run('segment', () => api.webinars.segment(session.id, segmentIndex - 1))}
                  style={iconButton}
                ><SkipBack size={16} /></button>
                <button
                  disabled={!session || segmentIndex >= segments.length - 1 || Boolean(busy)}
                  onClick={() => session && void run('segment', () => api.webinars.segment(session.id, segmentIndex + 1))}
                  style={iconButton}
                ><SkipForward size={16} /></button>
              </div>
            </div>
            {segments[segmentIndex] && (
              <>
                <div style={{ color: 'var(--color-apex-muted)', lineHeight: 1.6, fontSize: 13 }}>
                  {segments[segmentIndex].narration}
                </div>
                {segments[segmentIndex].demoCue && (
                  <div style={{ marginTop: 14, padding: 11, borderRadius: 7, background: 'var(--color-apex-brass-soft)', color: 'var(--color-apex-brass)', fontSize: 12 }}>
                    Demo cue: {segments[segmentIndex].demoCue}
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ ...card, padding: 20 }}>
            <div className="apex-eyebrow" style={{ marginBottom: 10 }}>Say something to the room</div>
            <div style={{ display: 'flex', gap: 9 }}>
              <input
                value={hostMessage}
                onChange={(e) => setHostMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hostMessage.trim()) void sendHostMessage();
                }}
                placeholder="Example: I’m pulling up the live APEX lead screen now…"
                style={{ flex: 1, background: 'var(--color-apex-bg)', color: 'var(--color-apex-text)', border: '1px solid var(--color-apex-line)', borderRadius: 6, padding: '10px 12px' }}
              />
              <button onClick={() => void sendHostMessage()} disabled={!hostMessage.trim() || Boolean(busy)} style={primaryButton}><MessageSquare size={15} /> Broadcast</button>
            </div>
          </div>

          <div style={{ ...card, padding: 20 }}>
            <div className="apex-eyebrow" style={{ marginBottom: 12 }}>Audience Q&A</div>
            {dashboard?.questions.length ? (
              <div style={{ display: 'grid', gap: 12 }}>
                {dashboard.questions.slice(0, 10).map((q) => (
                  <div key={q.id} style={{ borderTop: '1px solid var(--color-apex-line)', paddingTop: 12 }}>
                    <div style={{ color: 'var(--color-apex-text)', fontWeight: 650 }}>{q.question}</div>
                    <div style={{ color: 'var(--color-apex-muted)', fontSize: 13, lineHeight: 1.55, marginTop: 6 }}>{q.answer ?? 'Answering…'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: 'var(--color-apex-muted)', fontSize: 13 }}>No audience questions yet.</div>
            )}
          </div>

          <div style={{ ...card, padding: 20 }}>
            <div className="apex-eyebrow" style={{ marginBottom: 12 }}>Lead capture</div>
            {dashboard?.attendees.length ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--color-apex-muted)' }}>
                    <th style={th}>Attendee</th><th style={th}>Company</th><th style={th}>Contact</th><th style={th}>Score</th>
                  </tr></thead>
                  <tbody>
                    {dashboard.attendees.slice(0, 20).map((a) => (
                      <tr key={a.id} style={{ borderTop: '1px solid var(--color-apex-line)' }}>
                        <td style={td}><strong>{a.name}</strong></td>
                        <td style={td}>{a.company || '—'}</td>
                        <td style={td}><div>{a.email}</div><div style={{ color: 'var(--color-apex-muted)' }}>{a.phone || ''}</div></td>
                        <td style={td}><span style={{ color: a.engagement_score >= 25 ? 'var(--color-apex-green)' : 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>{a.engagement_score}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ color: 'var(--color-apex-muted)', fontSize: 13 }}>Registrations will appear here live.</div>
            )}
          </div>
        </section>

        <aside style={{ ...card, padding: 16, alignSelf: 'start', position: 'sticky', top: 82 }}>
          <div className="apex-eyebrow" style={{ margin: '4px 6px 10px' }}>Run of show</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {segments.map((segment, index) => {
              const active = index === segmentIndex;
              return (
                <button
                  key={segment.id}
                  disabled={!session || Boolean(busy)}
                  onClick={() => session && void run('segment', () => api.webinars.segment(session.id, index))}
                  style={{
                    textAlign: 'left',
                    border: 0,
                    borderLeft: active ? '3px solid var(--color-apex-brass)' : '3px solid transparent',
                    background: active ? 'var(--color-apex-brass-soft)' : 'transparent',
                    color: active ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
                    borderRadius: 5,
                    padding: '9px 10px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, opacity: 0.75 }}>{String(index + 1).padStart(2, '0')} · {segment.kicker}</div>
                  <div style={{ fontSize: 12, marginTop: 3, color: active ? 'var(--color-apex-text)' : 'inherit' }}>{segment.title}</div>
                </button>
              );
            })}
          </div>
        </aside>
      </div>

      {error && <div style={{ color: 'var(--color-apex-red)', fontSize: 13 }}>{error}</div>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: 12, border: '1px solid var(--color-apex-line)', borderRadius: 7, background: 'rgba(0,0,0,0.14)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-apex-muted)' }}>{label}</div>
      <div className="apex-display" style={{ fontSize: 24, marginTop: 5, color: 'var(--color-apex-text)' }}>{value}</div>
    </div>
  );
}

const primaryButton: React.CSSProperties = {
  border: 0,
  background: 'var(--color-apex-brass)',
  color: '#17130e',
  borderRadius: 6,
  padding: '9px 12px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  cursor: 'pointer',
  fontWeight: 700,
};

const secondaryButton: React.CSSProperties = {
  border: '1px solid var(--color-apex-line)',
  background: 'rgba(255,255,255,0.03)',
  color: 'var(--color-apex-text)',
  borderRadius: 6,
  padding: '9px 12px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  cursor: 'pointer',
};

const warningButton: React.CSSProperties = {
  ...secondaryButton,
  color: 'var(--color-apex-orange)',
  border: '1px solid rgba(214,161,92,0.35)',
};

const dangerButton: React.CSSProperties = {
  ...secondaryButton,
  color: 'var(--color-apex-red)',
  border: '1px solid rgba(196,92,102,0.35)',
};

const iconButton: React.CSSProperties = {
  border: '1px solid var(--color-apex-line)',
  background: 'rgba(255,255,255,0.03)',
  color: 'var(--color-apex-muted)',
  borderRadius: 6,
  width: 34,
  height: 34,
  display: 'inline-grid',
  placeItems: 'center',
  cursor: 'pointer',
};

const th: React.CSSProperties = { padding: '8px 10px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '10px', color: 'var(--color-apex-text)', verticalAlign: 'top' };
