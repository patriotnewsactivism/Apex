import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLiveVoiceCall } from '../hooks/useLiveVoiceCall';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { Goal, Agent, LogEntry } from '../lib/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import {
  Send,
  ChevronUp,
  Zap,
  Target,
  Activity,
  Users,
  ArrowUpRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader,
  Sparkles,
  Terminal,
  Brain,
  Bot,
  Mic,
  Square,
  Phone,
  PhoneOff,
  Minus,
} from 'lucide-react';

import { useIsMobile } from '../hooks/useIsMobile.js';

/* ── Stat card ─────────────────────────────────────────────────────────────── */

function StatCard({
  label,
  value,
  icon,
  color,
  glow,
  sub,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  glow?: string;
  sub?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{
        padding: '16px 18px',
        borderRadius: 14,
        background: `linear-gradient(135deg, ${color}08, ${color}03)`,
        border: `1px solid ${color}20`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* subtle glow */}
      {glow && (
        <div
          style={{
            position: 'absolute',
            top: -40,
            right: -40,
            width: 100,
            height: 100,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${glow}15, transparent)`,
            pointerEvents: 'none',
          }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: `${color}15`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color,
          }}
        >
          {icon}
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-apex-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 800,
          color,
          fontFamily: 'var(--font-mono)',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', marginTop: 4 }}>{sub}</div>
      )}
    </motion.div>
  );
}

/* ── Agent pill ─────────────────────────────────────────────────────────── */

function AgentPill({ agent }: { agent: Agent }) {
  const statusColors: Record<string, string> = {
    idle: '#64748b',
    active: '#5a9eae',
    working: '#5a9eae',
    thinking: '#8b7ec8',
    error: '#c45c66',
  };
  const c = statusColors[agent.liveStatus || agent.status] || '#64748b';
  const isActive = agent.liveStatus === 'working' || agent.liveStatus === 'active' || agent.liveStatus === 'thinking';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 10,
        background: isActive ? `${c}0a` : 'rgba(255,255,255,0.02)',
        border: `1px solid ${isActive ? `${c}25` : 'rgba(255,255,255,0.05)'}`,
        transition: 'all 0.2s',
      }}
    >
      <div style={{ position: 'relative' }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: c,
            boxShadow: isActive ? `0 0 8px ${c}80` : 'none',
          }}
        />
        {isActive && (
          <div
            style={{
              position: 'absolute',
              inset: -3,
              borderRadius: '50%',
              border: `1px solid ${c}40`,
              animation: 'pulse 2s ease-in-out infinite',
            }}
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: isActive ? 'var(--color-apex-text)' : 'var(--color-apex-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {agent.name}
        </div>
        <div style={{ fontSize: 9, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
          {agent.role}
        </div>
      </div>
    </motion.div>
  );
}

/* ── Log line ─────────────────────────────────────────────────────────── */

function LogLine({ entry }: { entry: LogEntry }) {
  const levelColors: Record<string, string> = {
    info: '#5a9eae',
    warn: '#c9a84a',
    error: '#c45c66',
    debug: '#64748b',
  };
  const c = levelColors[entry.level] || '#64748b';
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      style={{
        display: 'flex',
        gap: 8,
        padding: '6px 0',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        borderBottom: '1px solid rgba(255,255,255,0.03)',
      }}
    >
      <span style={{ color: 'var(--color-apex-muted)', flexShrink: 0, fontSize: 10 }}>{time}</span>
      <span
        style={{
          color: c,
          fontWeight: 600,
          textTransform: 'uppercase',
          fontSize: 9,
          flexShrink: 0,
          minWidth: 32,
        }}
      >
        {entry.level}
      </span>
      <span
        style={{
          color: 'var(--color-apex-text)',
          opacity: 0.8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.message}
      </span>
    </motion.div>
  );
}

/* ── Goal card ─────────────────────────────────────────────────────────── */

function GoalCard({ goal }: { goal: Goal }) {
  const statusConfig: Record<string, { color: string; icon: React.ReactNode; bg: string }> = {
    active: {
      color: '#5a9eae',
      icon: <Loader size={12} />,
      bg: 'rgba(90,158,174,0.06)',
    },
    completed: {
      color: '#6a9f78',
      icon: <CheckCircle2 size={12} />,
      bg: 'rgba(106,159,120,0.06)',
    },
    paused: {
      color: '#c9a84a',
      icon: <AlertTriangle size={12} />,
      bg: 'rgba(201,168,74,0.06)',
    },
    cancelled: {
      color: '#c45c66',
      icon: <AlertTriangle size={12} />,
      bg: 'rgba(196,92,102,0.06)',
    },
  };
  const cfg = statusConfig[goal.status] || statusConfig.active;
  const age = Date.now() - new Date(goal.createdAt).getTime();
  const ageStr =
    age < 3600000
      ? `${Math.floor(age / 60000)}m ago`
      : age < 86400000
        ? `${Math.floor(age / 3600000)}h ago`
        : `${Math.floor(age / 86400000)}d ago`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ x: 3, transition: { duration: 0.15 } }}
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        background: cfg.bg,
        border: `1px solid ${cfg.color}18`,
        borderLeft: `3px solid ${cfg.color}`,
        cursor: 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9,
            padding: '2px 7px',
            borderRadius: 4,
            background: `${cfg.color}18`,
            color: cfg.color,
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
          }}
        >
          {cfg.icon}
          {goal.status}
        </span>
        <span style={{ fontSize: 9, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
          P{goal.priority}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--color-apex-muted)' }}>
          {ageStr}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--color-apex-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {goal.title}
      </div>
      {goal.result && (
        <div
          style={{
            fontSize: 10,
            color: '#6a9f78',
            fontFamily: 'var(--font-mono)',
            marginTop: 6,
            padding: '4px 8px',
            background: 'rgba(106,159,120,0.05)',
            borderRadius: 4,
            overflowWrap: 'anywhere',
            // Wraps instead of nowrap: a nowrap line is a ~900px min-content
            // item that previously stretched the whole mobile page sideways.
            whiteSpace: 'normal',
          }}
        >
          ✓ {goal.result.slice(0, 120)}
        </div>
      )}
    </motion.div>
  );
}

/* ── Chat bubble ──────────────────────────────────────────────────────── */

interface ChatMessage {
  id: string;
  role: 'user' | 'system';
  text: string;
  goalCreated?: { id: string; title: string };
  timestamp: number;
}

/* ════════════════════════════════════════════════════════════════════════════ */
/* ██  MAIN COMPONENT                                                       ██ */
/* ════════════════════════════════════════════════════════════════════════════ */

// ChatPanel is the persistent, page-aware chat surface. It is mounted ONCE
// (inside FloatingChat, OUTSIDE the page swap in App.tsx) so navigating
// between Apex pages never unmounts it — an active live voice call and the
// message history survive navigation. It receives the page Don is currently
// viewing and feeds that to both the text chat and the live voice call, so
// "this", "that graph", "the thing on my screen" resolve correctly.
export interface ChatPanelProps {
  pageId?: string;
  pageTitle?: string;
  onMinimize?: () => void;
  onHeaderPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onVoiceStatus?: (status: import('../hooks/useLiveVoiceCall.js').LiveVoiceStatus) => void;
}

export function ChatPanel({
  pageId,
  pageTitle,
  onMinimize,
  onHeaderPointerDown,
  onVoiceStatus,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'system',
      text: "Talk to me — ask what's going on, catch up on approvals, or just hand me something to run with. I'll answer for real, not just log it.",
      timestamp: Date.now(),
    },
  ]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();

  // Follow-the-tail scrolling, gated to the messages container ONLY:
  //  - scrollIntoView would scroll EVERY scrollable ancestor (<main> on both
  //    axes), nudging the whole page sideways/vertically on every message —
  //    that was the "won't stay steady" bug. Setting scrollTop on the
  //    messages container itself touches only its own vertical overflow.
  //  - Gated on near-bottom so scrolling up to re-read stops the view from
  //    yanking back down on every incoming message; it re-follows once the
  //    user returns near the tail.
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const scrollToBottom = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    // Instant, not smooth: streaming updates (voice captions, rapid
    // back-and-forth) fire constantly and restart a smooth scroll every
    // time, which reads as jitter. Instant keeps the tail pinned.
    el.scrollTop = el.scrollHeight;
  };

  const handleMessagesScroll = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };


  // A real conversational turn: send the message + recent history to
  // /api/chat/message and let Apex decide whether to answer directly or
  // deploy a goal (see packages/api-server/src/routes/chat.ts). This
  // replaced the old behavior of silently turning every message into a
  // goal ticket with a canned "Got it" reply — there was no LLM in that
  // loop at all, which is why it only ever took orders.
  const chatMut = useMutation({
    mutationFn: (text: string) => {
      const history = messages
        .filter((m) => m.id !== 'welcome')
        .slice(-20)
        .map((m) => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.text }));
      return api.chat.message(text, history, pageTitle);
    },
    onSuccess: (result) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          role: 'system',
          text: result.reply,
          goalCreated: result.goalCreated,
          timestamp: Date.now(),
        },
      ]);
      if (result.goalCreated) {
        qc.invalidateQueries({ queryKey: ['goals'] });
      }
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'system',
          text: `❌ Couldn't get a response: ${err.message}`,
          timestamp: Date.now(),
        },
      ]);
    },
  });


  // Follow-the-tail: keep the newest message in view when the user is at
  // (or near) the bottom; never yank the view if they scrolled up to re-read.
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom();
  }, [messages, chatMut.isPending]);
  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { id: `usr-${Date.now()}`, role: 'user', text, timestamp: Date.now() },
    ]);
    setInput('');
    chatMut.mutate(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // ── Push-to-talk voice input ────────────────────────────────────────────
  // Records a clip with MediaRecorder, POSTs it to /api/transcribe
  // (Deepgram), and drops the transcript into the input box for review —
  // it does not auto-send, since a bad transcript should never silently
  // become a deployed goal.
  const startRecording = async () => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size === 0) return;
        setIsTranscribing(true);
        try {
          const token = localStorage.getItem('apex_token');
          const res = await fetch('/api/transcribe', {
            method: 'POST',
            headers: {
              'Content-Type': mimeType,
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: blob,
          });
          const data = (await res.json()) as { transcript?: string; error?: string };
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          if (data.transcript) {
            setInput((prev) => (prev ? `${prev} ${data.transcript}` : data.transcript!));
            inputRef.current?.focus();
          } else {
            setVoiceError("Didn't catch that — try again.");
          }
        } catch (err) {
          setVoiceError(err instanceof Error ? err.message : 'Transcription failed.');
        } finally {
          setIsTranscribing(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setVoiceError('Microphone access denied or unavailable.');
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  // ── Live voice call (Gemini Live, real-time, same tools as text chat) ──
  const [liveActivity, setLiveActivity] = useState<string | null>(null);
  // Tracks the id of the currently-open voice caption bubble so streaming
  // transcript fragments merge INTO it instead of each fragment becoming
  // its own message (Gemini Live captions arrive in tiny chunks — without
  // this, every word of a spoken turn landed in the chat as a separate
  // bubble). Cleared on turnComplete / role change.
  const openVoiceBubbleRef = useRef<{ id: string; role: string } | null>(null);
  const liveVoice = useLiveVoiceCall({
    onTranscript: (role, text) => {
      const open = openVoiceBubbleRef.current;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (open && last && last.id === open.id && open.role === role) {
          // Same turn, same speaker: merge the fragment into the bubble.
          return [...prev.slice(0, -1), { ...last, text: `${last.text}${last.text ? ' ' : ''}${text}` }];
        }
        const id = `voice-${role}-${Date.now()}`;
        openVoiceBubbleRef.current = { id, role };
        return [
          ...prev,
          {
            id,
            role: role === 'user' ? 'user' : 'system',
            text,
            timestamp: Date.now(),
          },
        ];
      });
      setLiveActivity(null);
    },
    onTurnComplete: () => {
      // Gemini finished one spoken turn — close the bubble so the next
      // fragment (user or assistant) starts a fresh message.
      openVoiceBubbleRef.current = null;
    },
    onGoalCreated: (goal) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `voice-goal-${Date.now()}`,
          role: 'system',
          text: `Deployed via voice call.`,
          goalCreated: goal,
          timestamp: Date.now(),
        },
      ]);
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
    onApprovalResolved: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
    onToolActivity: (name) => setLiveActivity(name.replace(/_/g, ' ')),
    onError: (message) => {
      setMessages((prev) => [
        ...prev,
        { id: `voice-err-${Date.now()}`, role: 'system', text: `❌ Voice call: ${message}`, timestamp: Date.now() },
      ]);
    },
  });

  // Lift the live-call status to the floating shell so a minimized FAB can
  // show the pulsing "on a call" dot.
  useEffect(() => {
    onVoiceStatus?.(liveVoice.status);
  }, [liveVoice.status, onVoiceStatus]);

  // Screen awareness, part 1: when a live voice call is active and Don
  // navigates to a different Apex page, tell the agent what he is now
  // looking at. The server relays this into the Gemini Live session as a
  // silent context note, so he can say "what about this one" while staring
  // at a goal/agent/log and be understood.
  useEffect(() => {
    if (!pageTitle) return;
    if (liveVoice.status !== 'live') return;
    liveVoice.sendContext(`Don just switched to the "${pageTitle}" screen (${pageId ?? 'unknown page'}).`);
  }, [pageTitle, pageId, liveVoice.status]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 0,
        height: '100%',
        minHeight: 0,
      }}
    >
          {/* Chat area */}
          <div
            style={{
              // Mobile: flex:none + explicit height. CRITICAL: `flex: 1`
              // (flex-basis: 0%) OVERRIDES the height property on a flex
              // item, so the panel used to grow with its message content and
              // reflow the whole page on every exchange. flex:none pins the
              // panel and the messages scroll inside it instead.
              flex: 1,
              minHeight: 0,
              borderRadius: 14,
              background: 'rgba(13,17,23,0.6)',
              border: '1px solid rgba(90,158,174,0.08)',
              backdropFilter: 'blur(8px)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Chat header — doubles as the drag handle on desktop */}
            <div
              onPointerDown={onHeaderPointerDown}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid rgba(90,158,174,0.06)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: onHeaderPointerDown ? 'grab' : undefined,
                touchAction: 'none',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, #5a9eae20, #8b7ec820)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Sparkles size={14} color="#5a9eae" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-apex-text)' }}>
                  APEX Command
                </div>
                <div style={{ fontSize: 9, color: 'var(--color-apex-muted)' }}>
                  Sees your screen: {pageTitle ?? '—'}
                </div>
              </div>
              {onMinimize && (
                <button
                  onClick={onMinimize}
                  aria-label="Minimize chat"
                  title="Minimize — chat and calls keep running"
                  style={{
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: '1px solid rgba(90,158,174,0.15)',
                    borderRadius: 6,
                    padding: '4px 6px',
                    cursor: 'pointer',
                    color: 'var(--color-apex-muted)',
                    display: 'flex',
                    flexShrink: 0,
                  }}
                >
                  <Minus size={13} />
                </button>
              )}
            </div>

            {/* Messages */}
            <div
              ref={messagesScrollRef}
              onScroll={handleMessagesScroll}
              style={{
                flex: 1,
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <AnimatePresence>
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    style={{
                      display: 'flex',
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <div
                      style={{
                        maxWidth: '85%',
                        padding: '10px 14px',
                        borderRadius:
                          msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                        background:
                          msg.role === 'user'
                            ? 'linear-gradient(135deg, rgba(90,158,174,0.15), rgba(139,126,200,0.08))'
                            : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${msg.role === 'user' ? 'rgba(90,158,174,0.18)' : 'rgba(255,255,255,0.05)'}`,
                        fontSize: 13,
                        lineHeight: 1.5,
                        color: 'var(--color-apex-text)',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                        minWidth: 0,
                      }}
                    >
                      {msg.text}
                      {msg.goalCreated && (
                        <div
                          style={{
                            marginTop: 8,
                            padding: '5px 9px',
                            borderRadius: 6,
                            background: 'rgba(106,159,120,0.1)',
                            border: '1px solid rgba(106,159,120,0.25)',
                            fontSize: 10,
                            color: '#6a9f78',
                            fontFamily: 'var(--font-mono)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                          }}
                        >
                          <Target size={10} />
                          Deployed goal: {msg.goalCreated.title}
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {chatMut.isPending && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: '#5a9eae',
                    fontSize: 12,
                  }}
                >
                  <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  Thinking...
                </motion.div>
              )}
              {voiceError && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={{ color: '#c45c66', fontSize: 11 }}
                >
                  {voiceError}
                </motion.div>
              )}
            </div>
          </div>

          {/* Live voice call bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
              padding: '8px 12px',
              marginBottom: 8,
              borderRadius: 10,
              background:
                liveVoice.status === 'live' || liveVoice.status === 'connecting'
                  ? 'rgba(106,159,120,0.06)'
                  : 'rgba(90,158,174,0.03)',
              border: `1px solid ${
                liveVoice.status === 'live' ? 'rgba(106,159,120,0.25)' : 'rgba(90,158,174,0.08)'
              }`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: 'var(--color-apex-muted)',
                flex: 1,
                minWidth: 0,
              }}
            >
              {liveVoice.status === 'live' && (
                <motion.span
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ repeat: Infinity, duration: 1.4 }}
                  style={{ width: 7, height: 7, borderRadius: '50%', background: '#6a9f78', display: 'inline-block' }}
                />
              )}
              {liveVoice.status === 'idle' || liveVoice.status === 'ended'
                ? 'Live voice call — talk to Apex directly (Gemini Live)'
                : liveVoice.status === 'connecting'
                  ? 'Connecting...'
                  : liveVoice.status === 'live'
                    ? liveActivity
                      ? `On the call — ${liveActivity}...`
                      : 'On the call — speak naturally'
                    : 'Call error'}
            </div>
            {liveVoice.status === 'live' || liveVoice.status === 'connecting' ? (
              <motion.button
                onClick={() => liveVoice.stop()}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                style={{
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid rgba(196,92,102,0.35)',
                  background: 'rgba(196,92,102,0.12)',
                  color: '#c45c66',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <PhoneOff size={14} /> Hang up
              </motion.button>
            ) : (
              <motion.button
                onClick={() => liveVoice.start(pageTitle ? `${pageTitle} (${pageId ?? 'chat'})` : undefined)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                style={{
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid rgba(90,158,174,0.25)',
                  background: 'rgba(90,158,174,0.1)',
                  color: '#5a9eae',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <Phone size={14} /> Start call
              </motion.button>
            )}
          </div>

          {/* Input area */}
          <div>
            {expanded && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{
                  fontSize: 10,
                  color: 'var(--color-apex-muted)',
                  marginBottom: 6,
                  padding: '8px 12px',
                  background: 'rgba(90,158,174,0.03)',
                  border: '1px solid rgba(90,158,174,0.08)',
                  borderRadius: 8,
                }}
              >
                <strong style={{ color: '#5a9eae' }}>Tips:</strong> Ask questions, check on approvals,
                or just talk it through — I'll only deploy a goal when you're actually giving an
                order. Shift+Enter for newlines. Tap the mic for voice input.
              </motion.div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <button
                onClick={() => setExpanded(!expanded)}
                style={{
                  background: 'rgba(13,17,23,0.6)',
                  border: '1px solid rgba(90,158,174,0.12)',
                  borderRadius: 10,
                  padding: '11px',
                  cursor: 'pointer',
                  color: expanded ? '#5a9eae' : 'var(--color-apex-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'all 0.15s',
                  flexShrink: 0,
                }}
              >
                <ChevronUp
                  size={16}
                  style={{
                    transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                  }}
                />
              </button>
              <textarea
                ref={inputRef}
                className="apex-input"
                aria-label="Chat message"
                placeholder="Ask me anything, or tell me what to do..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={expanded ? 4 : 1}
                style={{
                  flex: 1,
                  minWidth: 0,
                  resize: 'none',
                  minHeight: expanded ? 100 : 44,
                  transition: 'min-height 0.2s',
                  fontSize: 14,
                }}
              />
              <motion.button
                onClick={isRecording ? stopRecording : startRecording}
                disabled={isTranscribing || chatMut.isPending}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                title={isRecording ? 'Stop recording' : 'Voice input'}
                aria-label={isRecording ? 'Stop recording' : 'Voice input'}
                style={{
                  padding: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexShrink: 0,
                  borderRadius: 10,
                  border: `1px solid ${isRecording ? 'rgba(196,92,102,0.4)' : 'rgba(90,158,174,0.12)'}`,
                  background: isRecording ? 'rgba(196,92,102,0.12)' : 'rgba(13,17,23,0.6)',
                  color: isRecording ? '#c45c66' : 'var(--color-apex-muted)',
                  cursor: isTranscribing ? 'wait' : 'pointer',
                }}
              >
                {isTranscribing ? (
                  <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />
                ) : isRecording ? (
                  <Square size={16} />
                ) : (
                  <Mic size={16} />
                )}
              </motion.button>
              <motion.button
                className="btn-primary"
                onClick={handleSubmit}
                disabled={!input.trim() || chatMut.isPending}
                aria-label="Send chat message"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                style={{
                  padding: '11px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexShrink: 0,
                  borderRadius: 10,
                }}
              >
                <Send size={16} />
              </motion.button>
            </div>
          </div>
    </div>
  );
}

// QuickChat is now the overview PAGE (stats + roster + goals + live feed).
// The actual chat surface lives in ChatPanel, mounted once inside
// FloatingChat so it follows Don around Apex instead of dying on every
// page switch.
export function QuickChat() {
  const isMobile = useIsMobile();
  const { connected, agentStatuses } = useWebSocket();

  const { data: goals = [] } = useQuery({
    queryKey: ['goals'],
    queryFn: () => api.goals.list(),
    refetchInterval: 10000,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
    refetchInterval: 15000,
  });

  const { data: logs = [] } = useQuery({
    queryKey: ['logs-recent'],
    queryFn: () => api.logs.list(8),
    refetchInterval: 8000,
  });

  const activeGoals = goals.filter((g) => g.status === 'active').length;
  const completedGoals = goals.filter((g) => g.status === 'completed').length;
  const activeAgentCount = Object.values(agentStatuses).filter((st) => st !== 'idle').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 16 : 20 }}>
      {/* ── Top Stats Row ─────────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
          gap: isMobile ? 10 : 14,
        }}
      >
        <StatCard
          label="Active Goals"
          value={activeGoals}
          icon={<Target size={16} />}
          color="#5a9eae"
          glow="#5a9eae"
          sub={`${goals.length} total`}
        />
        <StatCard
          label="Completed"
          value={completedGoals}
          icon={<CheckCircle2 size={16} />}
          color="#6a9f78"
          glow="#6a9f78"
        />
        <StatCard
          label="Agents"
          value={`${activeAgentCount}/${agents.length}`}
          icon={<Users size={16} />}
          color="#8b7ec8"
          glow="#8b7ec8"
          sub={activeAgentCount > 0 ? 'working' : 'standing by'}
        />
        <StatCard
          label="Status"
          value={connected ? 'LIVE' : 'OFF'}
          icon={<Zap size={16} />}
          color={connected ? '#6a9f78' : '#c45c66'}
          glow={connected ? '#6a9f78' : '#c45c66'}
          sub={connected ? 'WebSocket connected' : 'Reconnecting...'}
        />
      </div>

      {/* The chat itself now floats — it follows you across every Apex
          page and stays open (voice calls keep running) while you browse.
          Expand it from the corner panel or the Chat nav item. */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--color-apex-muted)',
          padding: '8px 12px',
          background: 'rgba(90,158,174,0.03)',
          border: '1px solid rgba(90,158,174,0.08)',
          borderRadius: 8,
        }}
      >
        Chat floats with you now — open the corner panel (or tap Chat) and jump around Apex;
        it sees whichever screen you're on.
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: isMobile ? 16 : 20,
          alignItems: 'start',
        }}
      >

        {/* Agent roster */}
        <div
          style={{
            borderRadius: 14,
            background: 'rgba(13,17,23,0.6)',
            border: '1px solid rgba(139,126,200,0.08)',
            backdropFilter: 'blur(8px)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid rgba(139,126,200,0.06)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Bot size={14} color="#8b7ec8" />
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--color-apex-text)',
              }}
            >
              Agent Roster
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 9,
                color: 'var(--color-apex-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {agents.length} registered
            </span>
          </div>
          <div
            style={{
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxHeight: isMobile ? 200 : 240,
              overflowY: 'auto',
            }}
          >
            {agents.length === 0 ? (
              <div
                style={{
                  padding: '20px 12px',
                  textAlign: 'center',
                  color: 'var(--color-apex-muted)',
                  fontSize: 11,
                }}
              >
                No agents registered yet
              </div>
            ) : (
              agents.slice(0, 10).map((a) => <AgentPill key={a.id} agent={a} />)
            )}
          </div>
        </div>

        {/* Recent goals */}
        <div
          style={{
            borderRadius: 14,
            background: 'rgba(13,17,23,0.6)',
            border: '1px solid rgba(90,158,174,0.08)',
            backdropFilter: 'blur(8px)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid rgba(90,158,174,0.06)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Target size={14} color="#5a9eae" />
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>
              Recent Goals
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 9,
                color: 'var(--color-apex-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {activeGoals} active
            </span>
          </div>
          <div
            style={{
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: isMobile ? 250 : 300,
              overflowY: 'auto',
            }}
          >
            {goals.length === 0 ? (
              <div
                style={{
                  padding: '24px 12px',
                  textAlign: 'center',
                  color: 'var(--color-apex-muted)',
                  fontSize: 11,
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 6 }}>🎯</div>
                No goals yet — type a command above
              </div>
            ) : (
              goals.slice(0, 5).map((g) => <GoalCard key={g.id} goal={g} />)
            )}
          </div>
        </div>

        {/* Live log tail */}
        <div
          style={{
            borderRadius: 14,
            background: 'rgba(13,17,23,0.6)',
            border: '1px solid rgba(106,159,120,0.08)',
            backdropFilter: 'blur(8px)',
            overflow: 'hidden',
            flex: 1,
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid rgba(106,159,120,0.06)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Terminal size={14} color="#6a9f78" />
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>
              Live Feed
            </span>
            <div
              style={{
                marginLeft: 'auto',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: connected ? '#6a9f78' : '#c45c66',
                boxShadow: connected ? '0 0 6px #6a9f7880' : 'none',
              }}
            />
          </div>
          <div
            style={{
              padding: '6px 12px',
              maxHeight: isMobile ? 160 : 200,
              overflowY: 'auto',
            }}
          >
            {logs.length === 0 ? (
              <div
                style={{
                  padding: '16px 8px',
                  textAlign: 'center',
                  color: 'var(--color-apex-muted)',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Waiting for activity...
              </div>
            ) : (
              logs.slice(0, 8).map((l) => <LogLine key={l.id} entry={l} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
