import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Send, Users, Volume2, VolumeX, Sparkles } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { TavusWebinarHost } from './TavusWebinarHost.js';

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
  const [interactiveHostConsent, setInteractiveHostConsent] = useState(false);
  const [tavusHostState, setTavusHostState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [voiceOn, setVoiceOn] = useState(true);
  const [startedAudio, setStartedAudio] = useState(false);
  const [lastSpokenSegment, setLastSpokenSegment] = useState<number | null>(null);
  const seenQuestionIds = useRef(new Set<string>());
  const seenEventIds = useRef(new Set<string>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioQueueRef = useRef<Array<{ url: string; fallbackText: string }>>([]);
  const [roiMissedOpportunities, setRoiMissedOpportunities] = useState(25);
  const [roiAverageValue, setRoiAverageValue] = useState(500);
  const [roiCloseRate, setRoiCloseRate] = useState(30);
  const [roiRecoveryRate, setRoiRecoveryRate] = useState(50);
  const [roiTracked, setRoiTracked] = useState(false);
  const attendeeRef = useRef(attendeeId);
  const tavusTrackedRef = useRef(false);
  attendeeRef.current = attendeeId;

  const fallbackSpeak = useCallback((text: string) => {
    if (!voiceOn || !startedAudio || !('speechSynthesis' in window) || !text.trim()) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = naturalVoice() ?? null;
    utterance.rate = 1.02;
    utterance.pitch = 0.96;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  }, [startedAudio, voiceOn]);

  const stopVoice = useCallback(() => {
    audioQueueRef.current = [];
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const playVoice = useCallback((url: string, fallbackText: string, interrupt = false) => {
    if (!voiceOn || !startedAudio || !fallbackText.trim()) return;
    if (interrupt) stopVoice();

    const start = (item: { url: string; fallbackText: string }) => {
      const audio = new Audio(item.url);
      audio.preload = 'auto';
      audioRef.current = audio;
      const next = () => {
        audioRef.current = null;
        const queued = audioQueueRef.current.shift();
        if (queued) start(queued);
      };
      audio.onended = next;
      audio.onerror = () => {
        audioRef.current = null;
        fallbackSpeak(item.fallbackText);
        const queued = audioQueueRef.current.shift();
        if (queued) window.setTimeout(() => start(queued), 100);
      };
      void audio.play().catch(() => {
        audioRef.current = null;
        fallbackSpeak(item.fallbackText);
        const queued = audioQueueRef.current.shift();
        if (queued) window.setTimeout(() => start(queued), 100);
      });
    };

    const item = { url, fallbackText };
    if (audioRef.current && !audioRef.current.ended && !audioRef.current.paused) {
      audioQueueRef.current.push(item);
      return;
    }
    start(item);
  }, [fallbackSpeak, startedAudio, stopVoice, voiceOn]);

  const speakFallback = useCallback((text: string, interrupt = false) => {
    if (interrupt) stopVoice();
    fallbackSpeak(text);
  }, [fallbackSpeak, stopVoice]);

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
    if (tavusHostState !== 'error') return;
    if (!snapshot || !attendeeId || snapshot.session.status !== 'live') return;
    const index = snapshot.session.currentSegment;
    if (lastSpokenSegment === index) return;
    setLastSpokenSegment(index);
    if (snapshot.currentSegment.narration) {
      playVoice(
        `/api/webinar/public/${encodeURIComponent(slug)}/audio/segment/${encodeURIComponent(snapshot.currentSegment.id)}`,
        snapshot.currentSegment.narration,
        true,
      );
    }
  }, [snapshot, attendeeId, lastSpokenSegment, playVoice, slug, tavusHostState]);

  useEffect(() => {
    if (tavusHostState !== 'error') return;
    if (!snapshot || !attendeeId) return;
    for (const event of snapshot.events ?? []) {
      const id = String(event.id ?? '');
      if (!id || seenEventIds.current.has(id)) continue;
      seenEventIds.current.add(id);
      if (event.type === 'host_message' && event.payload?.message) {
        playVoice(
          `/api/webinar/public/${encodeURIComponent(slug)}/audio/event/${encodeURIComponent(id)}`,
          event.payload.message,
        );
      }
      if (event.type === 'human_takeover') {
        speakFallback('Matthew has taken the floor. Autonomous narration is paused.', true);
      }
      if (event.type === 'human_release') {
        const narration = snapshot.currentSegment.narration ?? '';
        setLastSpokenSegment(snapshot.session.currentSegment);
        if (narration) {
          playVoice(
            `/api/webinar/public/${encodeURIComponent(slug)}/audio/segment/${encodeURIComponent(snapshot.currentSegment.id)}`,
            narration,
            true,
          );
        } else {
          speakFallback('The AI co-host is back on the floor.', true);
        }
      }
    }
  }, [snapshot, attendeeId, playVoice, slug, speakFallback, tavusHostState]);

  useEffect(() => {
    if (tavusHostState !== 'error') return;
    if (!snapshot || !attendeeId) return;
    for (const item of [...snapshot.questions].reverse()) {
      if (seenQuestionIds.current.has(item.id)) continue;
      seenQuestionIds.current.add(item.id);
      if (item.answer) {
        const text = `Audience question: ${item.question}. ${item.answer}`;
        playVoice(
          `/api/webinar/public/${encodeURIComponent(slug)}/audio/question/${encodeURIComponent(item.id)}`,
          text,
        );
      }
    }
  }, [snapshot, attendeeId, playVoice, slug, tavusHostState]);

  useEffect(() => {
    if (tavusHostState === 'ready') stopVoice();
    if (!attendeeId || tavusHostState !== 'ready' || tavusTrackedRef.current) return;
    tavusTrackedRef.current = true;
    void fetch(`/api/webinar/public/${encodeURIComponent(slug)}/engagement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendeeId, type: 'interactive_video_host_ready' }),
    }).catch(() => {});
  }, [attendeeId, slug, stopVoice, tavusHostState]);

  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    setJoinError('');
    if (!interactiveHostConsent) {
      setJoinError('Please confirm the interactive AI host notice before entering.');
      return;
    }
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
        window.setTimeout(() => {
          playVoice(
            `/api/webinar/public/${encodeURIComponent(slug)}/audio/segment/${encodeURIComponent(room.currentSegment.id)}`,
            room.currentSegment.narration ?? '',
            true,
          );
        }, 250);
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
      if (data.answer && data.id) {
        playVoice(
          `/api/webinar/public/${encodeURIComponent(slug)}/audio/question/${encodeURIComponent(String(data.id))}`,
          `Your question: ${current}. ${String(data.answer)}`,
        );
      }
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

  const roiEstimate = useMemo(() => {
    const missed = Math.max(0, roiMissedOpportunities);
    const value = Math.max(0, roiAverageValue);
    const close = Math.min(100, Math.max(0, roiCloseRate)) / 100;
    const recovery = Math.min(100, Math.max(0, roiRecoveryRate)) / 100;
    return missed * value * close * recovery;
  }, [roiAverageValue, roiCloseRate, roiMissedOpportunities, roiRecoveryRate]);

  const trackRoi = () => {
    if (!snapshot || !attendeeId) return;
    setRoiTracked(true);
    void fetch(`/api/webinar/public/${encodeURIComponent(slug)}/engagement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attendeeId,
        type: 'roi_calculated',
        missedOpportunities: roiMissedOpportunities,
        averageValue: roiAverageValue,
        closeRate: roiCloseRate,
        recoveryRate: roiRecoveryRate,
        estimate: roiEstimate,
      }),
    }).catch(() => {});
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
      <div className="webinar-room-join" style={{ minHeight: '100vh', background: 'radial-gradient(circle at 25% 0%, #242017 0%, #0d0f13 44%)', color: '#f4eee4', padding: isMobile ? '20px 14px 32px' : 'clamp(20px, 5vw, 64px)', width: '100%', maxWidth: '100%' }}>
        <div style={{ maxWidth: 980, margin: '0 auto' }}>
          <div style={{ fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#c9a66b', marginBottom: 18 }}>APEX × BuildMyBot.app</div>
          <h1 style={{ fontSize: isMobile ? 34 : 'clamp(38px, 7vw, 76px)', lineHeight: isMobile ? 1.02 : 0.98, margin: 0, maxWidth: 850, letterSpacing: '-0.045em', overflowWrap: 'anywhere' }}>{snapshot.session.title}</h1>
          <p style={{ fontSize: isMobile ? 15 : 18, lineHeight: 1.6, color: '#a9a7a2', maxWidth: 760, margin: isMobile ? '18px 0 22px' : '24px 0 34px' }}>{snapshot.session.description}</p>
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
              <label
                style={{
                  gridColumn: '1 / -1',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  color: '#a9a7a2',
                  fontSize: 12,
                  lineHeight: 1.5,
                  padding: '4px 1px',
                }}
              >
                <input
                  required
                  type="checkbox"
                  checked={interactiveHostConsent}
                  onChange={(event) => setInteractiveHostConsent(event.target.checked)}
                  style={{ marginTop: 2, width: 17, height: 17, accentColor: '#c9a66b', flexShrink: 0 }}
                />
                <span>
                  Start my interactive AI video host. My browser may ask for microphone/camera permission so I can talk with the host face-to-face.
                </span>
              </label>
              <button
                type="submit"
                disabled={!interactiveHostConsent}
                style={{ ...buttonStyle, gridColumn: '1 / -1', padding: '14px 18px', opacity: interactiveHostConsent ? 1 : 0.55 }}
              >
                Enter interactive webinar
              </button>
            </form>
            <div style={{ color: '#777b85', fontSize: 12, marginTop: 14 }}>
              Each attendee gets a separate Tavus-powered conversation inside the webinar room. The browser controls your microphone and camera permissions.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const segment = snapshot.currentSegment;
  const live = snapshot.session.status === 'live';

  return (
    <div className="webinar-room-live" style={{ minHeight: '100vh', background: '#0d0f13', color: '#f4eee4', paddingBottom: isMobile ? 24 : 40, width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
      <header className="webinar-room-header" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', padding: isMobile ? '10px 12px' : '16px clamp(16px, 4vw, 52px)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: isMobile ? 8 : 16, position: 'sticky', top: 0, zIndex: 10, background: 'rgba(13,15,19,0.94)', backdropFilter: 'blur(14px)', minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: isMobile ? 9 : 11, letterSpacing: '0.16em', color: '#c9a66b', textTransform: 'uppercase' }}>APEX × BuildMyBot.app</div>
          <div style={{ fontSize: isMobile ? 12 : 14, marginTop: 4, color: '#d6d2ca', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{snapshot.session.title}</div>
        </div>
        <div className="webinar-room-header-actions" style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 7 : 12, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#9b9da4', fontSize: isMobile ? 10 : 12, whiteSpace: 'nowrap' }}><Users size={isMobile ? 12 : 14} /> {snapshot.attendeeCount}{isMobile ? '' : ' live'}</div>
          {tavusHostState === 'error' ? (
            <button onClick={() => {
              if (!startedAudio) {
                setStartedAudio(true);
                setVoiceOn(true);
                setLastSpokenSegment(null);
                return;
              }
              setVoiceOn((value) => {
                const next = !value;
                if (!next) stopVoice();
                if (next) setLastSpokenSegment(null);
                return next;
              });
            }} className="apex-icon-btn" style={iconButtonStyle} title={voiceOn && startedAudio ? 'Mute fallback audio host' : 'Unmute fallback audio host'}>
              {voiceOn && startedAudio ? <Volume2 size={17} /> : <VolumeX size={17} />}
            </button>
          ) : (
            <div
              style={{
                padding: '6px 9px',
                borderRadius: 999,
                border: '1px solid rgba(120,181,140,0.24)',
                background: 'rgba(120,181,140,0.08)',
                color: tavusHostState === 'ready' ? '#78b58c' : '#c9a66b',
                fontSize: isMobile ? 9 : 10,
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              {tavusHostState === 'ready' ? 'VIDEO HOST LIVE' : 'HOST LOADING'}
            </div>
          )}
        </div>
      </header>

      <div style={{ height: 3, background: '#252830' }}><div style={{ height: '100%', width: `${progress}%`, background: '#c9a66b', transition: 'width 0.5s ease' }} /></div>

      <main className="webinar-room-main" style={{ maxWidth: 1180, width: '100%', margin: '0 auto', padding: isMobile ? '14px 12px 22px' : 'clamp(22px, 4vw, 52px) clamp(16px, 3vw, 30px)', display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1.7fr) minmax(280px, 0.7fr)', gap: isMobile ? 12 : 24, minWidth: 0 }}>
        <div className="webinar-room-primary" style={{ display: 'grid', gap: isMobile ? 12 : 18, minWidth: 0 }}>
          <TavusWebinarHost onStateChange={setTavusHostState} compact={isMobile} />
        <section className="webinar-room-stage" style={{ ...card, minHeight: isMobile ? 0 : 520, padding: isMobile ? '22px 16px 48px' : 'clamp(26px, 5vw, 58px)', position: 'relative', overflow: 'hidden', minWidth: 0 }}>
          <div style={{ position: 'absolute', inset: '0 auto auto 0', width: 180, height: 4, background: '#c9a66b' }} />
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#c9a66b' }}>{segment.kicker}</div>
          <h2 style={{ fontSize: isMobile ? 30 : 'clamp(34px, 5vw, 60px)', lineHeight: isMobile ? 1.07 : 1.02, margin: isMobile ? '14px 0 20px' : '20px 0 30px', letterSpacing: '-0.04em', overflowWrap: 'anywhere' }}>{segment.title}</h2>
          <div style={{ display: 'grid', gap: 15, maxWidth: 780 }}>
            {segment.bullets.map((bullet) => (
              <div key={bullet} style={{ display: 'flex', gap: isMobile ? 10 : 14, alignItems: 'flex-start', color: '#d6d2ca', fontSize: isMobile ? 15 : 18, lineHeight: 1.5, minWidth: 0 }}>
                <span style={{ color: '#c9a66b', marginTop: 1 }}>→</span><span>{bullet}</span>
              </div>
            ))}
          </div>
          {segment.demoCue && (
            <div style={{ marginTop: isMobile ? 22 : 34, padding: isMobile ? 12 : 16, borderRadius: 10, background: 'rgba(201,166,107,0.09)', color: '#c9a66b', fontSize: 13, overflowWrap: 'anywhere' }}>{segment.demoCue}</div>
          )}
          {segment.id === 'roi' && (
            <div style={{ marginTop: isMobile ? 22 : 30, padding: isMobile ? 14 : 20, borderRadius: 12, border: '1px solid rgba(201,166,107,0.22)', background: 'rgba(0,0,0,0.18)', minWidth: 0 }}>
              <div style={{ color: '#c9a66b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em' }}>Live ROI worksheet</div>
              <div style={{ color: '#8d9099', fontSize: 12, marginTop: 7, lineHeight: 1.5 }}>
                These are editable scenario inputs, not a performance guarantee. Use your own numbers.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 14, minWidth: 0 }}>
                <RoiInput label="Missed opportunities / month" value={roiMissedOpportunities} onChange={setRoiMissedOpportunities} />
                <RoiInput label="Average customer value ($)" value={roiAverageValue} onChange={setRoiAverageValue} />
                <RoiInput label="Close rate (%)" value={roiCloseRate} onChange={setRoiCloseRate} />
                <RoiInput label="Recoverable share (%)" value={roiRecoveryRate} onChange={setRoiRecoveryRate} />
              </div>
              <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ color: '#777b85', fontSize: 11 }}>Scenario monthly recovered revenue</div>
                  <div style={{ fontSize: isMobile ? 26 : 30, fontWeight: 800, marginTop: 3, overflowWrap: 'anywhere' }}>
                    {roiEstimate.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                  </div>
                </div>
                <button onClick={trackRoi} style={{ ...buttonStyle, opacity: roiTracked ? 0.75 : 1, width: isMobile ? '100%' : undefined }}>
                  {roiTracked ? 'Scenario saved' : 'Use this scenario'}
                </button>
              </div>
            </div>
          )}
          <div style={{ position: 'absolute', right: isMobile ? 16 : 28, bottom: isMobile ? 14 : 24, fontSize: 12, color: '#656871' }}>{snapshot.session.currentSegment + 1} / {snapshot.segments.length}</div>
        </section>
        </div>

        <aside className="webinar-room-sidebar" style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 18, minWidth: 0 }}>
          <div style={{ ...card, padding: isMobile ? 15 : 20, minWidth: 0 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#777b85', marginBottom: 10 }}>Host status</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: live ? '#78b58c' : snapshot.session.status === 'paused' ? '#d6a15c' : '#777b85', boxShadow: live ? '0 0 0 5px rgba(120,181,140,0.12)' : 'none' }} />
              <strong>
                {snapshot.session.status === 'draft'
                  ? 'Waiting to begin'
                  : snapshot.session.status === 'paused'
                    ? 'Human takeover active'
                    : snapshot.session.status === 'ended'
                      ? 'Webinar ended'
                      : tavusHostState === 'ready'
                        ? 'Interactive video host live'
                        : tavusHostState === 'error'
                          ? 'Audio fallback host live'
                          : 'Interactive host loading'}
              </strong>
            </div>
            <div style={{ marginTop: 10, color: '#8d9099', fontSize: 13, lineHeight: 1.5 }}>
              Tavus runs a separate live conversation for this attendee while APEX keeps the webinar state, slides, Q&A, engagement and follow-up workflow synchronized.
            </div>
          </div>

          <div style={{ ...card, padding: isMobile ? 15 : 20, minWidth: 0 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#777b85', marginBottom: 8 }}>Text question backup</div>
            <div style={{ color: '#8d9099', fontSize: 11, lineHeight: 1.45, marginBottom: 12 }}>
              Talk directly to the video host above. Use this box when you prefer text or need a fallback.
            </div>
            <form onSubmit={ask}>
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about APEX, BuildMyBot, automation, voice, campaigns…" rows={5} style={{ ...inputStyle, width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
              <button disabled={answering || !question.trim()} type="submit" style={{ ...buttonStyle, marginTop: 10, width: '100%', opacity: answering ? 0.65 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Send size={15} /> {answering ? 'Sending…' : 'Send text question'}
              </button>
            </form>
          </div>

          <button onClick={clickCta} style={{ ...buttonStyle, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%' }}>
            {snapshot.session.ctaLabel} <ExternalLink size={16} />
          </button>
        </aside>
      </main>

      {snapshot.questions.length > 0 && (
        <section style={{ maxWidth: 1180, margin: '0 auto', padding: isMobile ? '0 12px 24px' : '0 clamp(16px, 3vw, 30px) 40px' }}>
          <div style={{ ...card, padding: isMobile ? 15 : 22, minWidth: 0 }}>
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

function RoiInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: 'grid', gap: 6, color: '#8d9099', fontSize: 11 }}>
      {label}
      <input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
      />
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.045)',
  color: '#f4eee4',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '12px 13px',
  outline: 'none',
  fontSize: 16,
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
