import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Send, Users, Volume2, VolumeX, Sparkles } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile.js';

type Segment = {
  id: string;
  title: string;
  kicker: string;
  durationSeconds: number;
  bullets: string[];
  narration?: string;
  demoCue?: string;
};

type WebinarSnapshot = {
  session: {
    id: string;
    slug: string;
    title: string;
    description: string | null;
    hostName: string;
    mode: string;
    status: 'draft' | 'live' | 'paused' | 'ended';
    autonomous: boolean;
    currentSegment: number;
    startedAt: string | null;
    ctaLabel: string;
    ctaUrl: string;
  };
  currentSegment: Segment;
  segments: Segment[];
  attendeeCount: number;
  questions: Array<{
    id: string;
    question: string;
    answer: string | null;
    status: string;
    createdAt: string;
    answeredAt: string | null;
  }>;
  events: Array<{
    id?: string;
    type?: string;
    payload?: { message?: string } | null;
    created_at?: string;
    createdAt?: string;
  }>;
};

function naturalVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  const english = voices.filter((voice) => /^en(-|_)/i.test(voice.lang));
  const preferred = [
    /Google US English/i,
    /Microsoft.*(Guy|Ryan|Andrew|Brian|David)/i,
    /Samantha/i,
    /Alex/i,
    /Daniel/i,
  ];
  for (const pattern of preferred) {
    const match = english.find((voice) => pattern.test(voice.name));
    if (match) return match;
  }
  return english[0] ?? voices[0];
}

export function WebinarRoom({ slug }: { slug: string }) {
  const isMobile = useIsMobile();
  const [snapshot, setSnapshot] = useState<WebinarSnapshot | null>(null);
  const [attendeeId, setAttendeeId] = useState(() => sessionStorage.getItem(`apex-webinar-${slug}`) ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [question, setQuestion] = useState('');
  const [answering, setAnswering] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [voiceOn, setVoiceOn] = useState(true);
  const [startedAudio, setStartedAudio] = useState(false);
  const [lastSpokenSegment, setLastSpokenSegment] = useState<number | null>(null);
  const seenQuestionIds = useRef(new Set<string>());
  const seenEventIds = useRef(new Set<string>());
  const attendeeRef = useRef(attendeeId);
  attendeeRef.current = attendeeId;

  const speak = useCallback((text: string, interrupt = false) => {
    if (!voiceOn || !startedAudio || !('speechSynthesis' in window) || !text.trim()) return;
    if (interrupt) window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = naturalVoice() ?? null;
    utterance.rate = 1.02;
    utterance.pitch = 0.96;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  }, [startedAudio, voiceOn]);

  const fetchSnapshot = useCallback(async () => {
    const res = await fetch(`/api/webinar/public/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'This webinar room does not exist.' : 'Unable to load the webinar.');
    const data = await res.json() as WebinarSnapshot;
    setSnapshot(data);
    return data;
  }, [slug]);

  useEffect(() => {
    void fetchSnapshot().catch((error) => setJoinError(error instanceof Error ? error.message : String(error)));
  }, [fetchSnapshot]);

  useEffect(() => {
    if (!attendeeId) return;
    const poll = window.setInterval(() => {
      void fetchSnapshot().catch(() => {});
    }, 2500);
    const heartbeat = window.setInterval(() => {
      void fetch(`/api/webinar/public/${encodeURIComponent(slug)}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendeeId: attendeeRef.current }),
      }).catch(() => {});
    }, 30000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(heartbeat);
    };
  }, [attendeeId, fetchSnapshot, slug]);

  useEffect(() => {
    if (!snapshot || !attendeeId || snapshot.session.status !== 'live') return;
    const index = snapshot.session.currentSegment;
    if (lastSpokenSegment === index) return;
    setLastSpokenSegment(index);
    if (snapshot.currentSegment.narration) {
      speak(snapshot.currentSegment.narration, true);
    }
  }, [snapshot, attendeeId, lastSpokenSegment, speak]);

  useEffect(() => {
    if (!snapshot || !attendeeId) return;
    for (const event of snapshot.events ?? []) {
      const id = String(event.id ?? '');
      if (!id || seenEventIds.current.has(id)) continue;
      seenEventIds.current.add(id);
      if (event.type === 'host_message' && event.payload?.message) {
        speak(event.payload.message);
      }
      if (event.type === 'human_takeover') {
        speak('Matthew has taken the floor. Autonomous narration is paused.');
      }
      if (event.type === 'human_release') {
        const narration = snapshot.currentSegment.narration ?? '';
        setLastSpokenSegment(snapshot.session.currentSegment);
        speak(narration || 'The AI co-host is back on the floor.', true);
      }
    }
  }, [snapshot, attendeeId, speak]);

  useEffect(() => {
    if (!snapshot || !attendeeId) return;
    for (const item of [...snapshot.questions].reverse()) {
      if (seenQuestionIds.current.has(item.id)) continue;
      seenQuestionIds.current.add(item.id);
      if (item.answer) speak(`Audience question: ${item.question}. ${item.answer}`);
    }
  }, [snapshot, attendeeId, speak]);

  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    setJoinError('');
    setStartedAudio(true);
    if ('speechSynthesis' in window) {
      // Warm the browser's audio permission during the user gesture.
      const warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0.01;
      window.speechSynthesis.speak(warm);
    }
    try {
      const res = await fetch(`/api/webinar/public/${encodeURIComponent(slug)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, company, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ? 'Please check your registration details.' : 'Unable to join.');
      const id = String(data.attendeeId);
      sessionStorage.setItem(`apex-webinar-${slug}`, id);
      setAttendeeId(id);
      const room = data.snapshot as WebinarSnapshot;
      setSnapshot(room);
      for (const q of room.questions ?? []) seenQuestionIds.current.add(q.id);
      for (const e of room.events ?? []) if (e.id) seenEventIds.current.add(String(e.id));
      if (room.session.status === 'live' && room.currentSegment.narration) {
        setLastSpokenSegment(room.session.currentSegment);
        window.setTimeout(() => speak(room.currentSegment.narration ?? '', true), 250);
      }
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : String(error));
    }
  };

  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!attendeeId || !question.trim() || answering) return;
    const current = question.trim();
    setQuestion('');
    setAnswering(true);
    try {
      const res = await fetch(`/api/webinar/public/${encodeURIComponent(slug)}/question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendeeId, question: current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error('The question could not be sent.');
      if (data.id) seenQuestionIds.current.add(String(data.id));
      if (data.answer) speak(`Your question: ${current}. ${String(data.answer)}`);
      await fetchSnapshot();
    } finally {
      setAnswering(false);
    }
  };

  const clickCta = () => {
    if (!snapshot || !attendeeId) return;
    void fetch(`/api/webinar/public/${encodeURIComponent(slug)}/engagement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendeeId, type: 'cta_click' }),
    }).catch(() => {});
    window.open(snapshot.session.ctaUrl, '_blank', 'noopener,noreferrer');
  };

  const progress = useMemo(() => {
    if (!snapshot) return 0;
    const count = Math.max(1, snapshot.segments.length);
    return Math.round(((snapshot.session.currentSegment + 1) / count) * 100);
  }, [snapshot]);

  const card: React.CSSProperties = {
    background: 'rgba(22,24,30,0.92)',
    border: '1px solid rgba(201,166,107,0.22)',
    borderRadius: 14,
    boxShadow: '0 24px 70px rgba(0,0,0,0.32)',
  };

  if (!snapshot && joinError) {
    return <div style={{ minHeight: '100vh', background: '#0d0f13', color: '#f4eee4', display: 'grid', placeItems: 'center', padding: 24 }}>{joinError}</div>;
  }

  if (!snapshot) {
    return <div style={{ minHeight: '100vh', background: '#0d0f13', color: '#c9a66b', display: 'grid', placeItems: 'center' }}>Opening webinar room…</div>;
  }

  if (!attendeeId) {
    return (
      <div style={{ minHeight: '100vh', background: 'radial-gradient(circle at 25% 0%, #242017 0%, #0d0f13 44%)', color: '#f4eee4', padding: 'clamp(20px, 5vw, 64px)' }}>
        <div style={{ maxWidth: 980, margin: '0 auto' }}>
          <div style={{ fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#c9a66b', marginBottom: 18 }}>APEX × BuildMyBot.app</div>
          <h1 style={{ fontSize: 'clamp(38px, 7vw, 76px)', lineHeight: 0.98, margin: 0, maxWidth: 850, letterSpacing: '-0.045em' }}>{snapshot.session.title}</h1>
          <p style={{ fontSize: 18, lineHeight: 1.6, color: '#a9a7a2', maxWidth: 760, margin: '24px 0 34px' }}>{snapshot.session.description}</p>
          <div style={{ ...card, padding: 'clamp(20px, 4vw, 34px)', maxWidth: 680 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 22 }}>
              <Sparkles size={18} color="#c9a66b" />
              <strong>Join the AI-hosted room</strong>
            </div>
            <form onSubmit={join} style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" style={inputStyle} />
              <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" style={inputStyle} />
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" style={inputStyle} />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" style={inputStyle} />
              {joinError && <div style={{ gridColumn: '1 / -1', color: '#e58b92', fontSize: 13 }}>{joinError}</div>}
              <button type="submit" style={{ ...buttonStyle, gridColumn: '1 / -1', padding: '14px 18px' }}>Enter webinar</button>
            </form>
            <div style={{ color: '#777b85', fontSize: 12, marginTop: 14 }}>Entering enables the AI narration in your browser. You can mute it at any time.</div>
          </div>
        </div>
      </div>
    );
  }

  const segment = snapshot.currentSegment;
  const live = snapshot.session.status === 'live';

  return (
    <div style={{ minHeight: '100vh', background: '#0d0f13', color: '#f4eee4', paddingBottom: 40 }}>
      <header style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '16px clamp(16px, 4vw, 52px)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, position: 'sticky', top: 0, zIndex: 10, background: 'rgba(13,15,19,0.94)', backdropFilter: 'blur(14px)' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.16em', color: '#c9a66b', textTransform: 'uppercase' }}>APEX × BuildMyBot.app</div>
          <div style={{ fontSize: 14, marginTop: 4, color: '#d6d2ca' }}>{snapshot.session.title}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9b9da4', fontSize: 12 }}><Users size={14} /> {snapshot.attendeeCount} live</div>
          <button onClick={() => {
            if (!startedAudio) {
              setStartedAudio(true);
              setVoiceOn(true);
              setLastSpokenSegment(null);
              return;
            }
            setVoiceOn((value) => {
              const next = !value;
              if (!next && 'speechSynthesis' in window) window.speechSynthesis.cancel();
              if (next) setLastSpokenSegment(null);
              return next;
            });
          }} style={iconButtonStyle} title={voiceOn && startedAudio ? 'Mute AI host' : 'Unmute AI host'}>
            {voiceOn && startedAudio ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </button>
        </div>
      </header>

      <div style={{ height: 3, background: '#252830' }}><div style={{ height: '100%', width: `${progress}%`, background: '#c9a66b', transition: 'width 0.5s ease' }} /></div>

      <main style={{ maxWidth: 1180, margin: '0 auto', padding: 'clamp(22px, 4vw, 52px) clamp(16px, 3vw, 30px)', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.7fr) minmax(280px, 0.7fr)', gap: 24 }}>
        <section style={{ ...card, minHeight: 520, padding: 'clamp(26px, 5vw, 58px)', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: '0 auto auto 0', width: 180, height: 4, background: '#c9a66b' }} />
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#c9a66b' }}>{segment.kicker}</div>
          <h2 style={{ fontSize: 'clamp(34px, 5vw, 60px)', lineHeight: 1.02, margin: '20px 0 30px', letterSpacing: '-0.04em' }}>{segment.title}</h2>
          <div style={{ display: 'grid', gap: 15, maxWidth: 780 }}>
            {segment.bullets.map((bullet) => (
              <div key={bullet} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', color: '#d6d2ca', fontSize: 18, lineHeight: 1.5 }}>
                <span style={{ color: '#c9a66b', marginTop: 1 }}>→</span><span>{bullet}</span>
              </div>
            ))}
          </div>
          {segment.demoCue && (
            <div style={{ marginTop: 34, padding: 16, borderRadius: 10, background: 'rgba(201,166,107,0.09)', color: '#c9a66b', fontSize: 13 }}>{segment.demoCue}</div>
          )}
          <div style={{ position: 'absolute', right: 28, bottom: 24, fontSize: 12, color: '#656871' }}>{snapshot.session.currentSegment + 1} / {snapshot.segments.length}</div>
        </section>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ ...card, padding: 20 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#777b85', marginBottom: 10 }}>Host status</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: live ? '#78b58c' : snapshot.session.status === 'paused' ? '#d6a15c' : '#777b85', boxShadow: live ? '0 0 0 5px rgba(120,181,140,0.12)' : 'none' }} />
              <strong>{snapshot.session.status === 'draft' ? 'Waiting to begin' : snapshot.session.status === 'paused' ? 'Matthew has the floor' : snapshot.session.status === 'ended' ? 'Webinar ended' : snapshot.session.autonomous ? 'AI host live' : 'Co-host mode'}</strong>
            </div>
            <div style={{ marginTop: 10, color: '#8d9099', fontSize: 13, lineHeight: 1.5 }}>Host: {snapshot.session.hostName} · {snapshot.session.mode}</div>
          </div>

          <div style={{ ...card, padding: 20 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#777b85', marginBottom: 12 }}>Ask a question</div>
            <form onSubmit={ask}>
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about APEX, BuildMyBot, automation, voice, campaigns…" rows={5} style={{ ...inputStyle, width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
              <button disabled={answering || !question.trim()} type="submit" style={{ ...buttonStyle, marginTop: 10, width: '100%', opacity: answering ? 0.65 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Send size={15} /> {answering ? 'AI is answering…' : 'Ask the AI host'}
              </button>
            </form>
          </div>

          <button onClick={clickCta} style={{ ...buttonStyle, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {snapshot.session.ctaLabel} <ExternalLink size={16} />
          </button>
        </aside>
      </main>

      {snapshot.questions.length > 0 && (
        <section style={{ maxWidth: 1180, margin: '0 auto', padding: '0 clamp(16px, 3vw, 30px) 40px' }}>
          <div style={{ ...card, padding: 22 }}>
            <div style={{ fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#c9a66b', marginBottom: 16 }}>Recent Q&A</div>
            <div style={{ display: 'grid', gap: 14 }}>
              {snapshot.questions.slice(0, 5).map((item) => (
                <div key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 14 }}>
                  <div style={{ color: '#f4eee4', fontWeight: 650 }}>{item.question}</div>
                  <div style={{ color: '#a9a7a2', lineHeight: 1.55, marginTop: 7 }}>{item.answer}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.045)',
  color: '#f4eee4',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '12px 13px',
  outline: 'none',
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  background: '#c9a66b',
  color: '#15130f',
  border: 0,
  borderRadius: 8,
  padding: '12px 15px',
  fontWeight: 750,
  cursor: 'pointer',
};

const iconButtonStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  color: '#d6d2ca',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  padding: 8,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
};
