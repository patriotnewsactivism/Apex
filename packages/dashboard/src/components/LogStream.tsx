import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWebSocket, type ApexEvent } from '../hooks/useWebSocket.js';

const LEVEL_COLORS: Record<string, string> = {
  debug: '#64748b',
  info: '#e2e8f0',
  warn: '#ffd60a',
  error: '#ff3b5c',
  thinking: '#00e5ff',
  acting: '#b84cff',
};

const LEVEL_ICONS: Record<string, string> = {
  debug: '🔍',
  info: '📋',
  warn: '⚠️',
  error: '❌',
  thinking: '🧠',
  acting: '⚡',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Chicago' });
}

export function LogStream() {
  const { events } = useWebSocket();
  const bottomRef = useRef<HTMLDivElement>(null);

  const logEvents = events.filter((e) => e.type === 'log') as Extract<ApexEvent, { type: 'log' }>[];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logEvents.length]);

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '12px',
      }}
    >
      {logEvents.length === 0 && (
        <div style={{ color: 'var(--color-apex-muted)', textAlign: 'center', marginTop: 40 }}>
          Waiting for agent activity...
        </div>
      )}
      <AnimatePresence initial={false}>
        {logEvents.map((e, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.15 }}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              padding: '3px 0',
              borderBottom: '1px solid rgba(255,255,255,0.03)',
            }}
          >
            <span style={{ color: 'var(--color-apex-muted)', flexShrink: 0, fontSize: 10, paddingTop: 1 }}>
              {formatTime(e.timestamp)}
            </span>
            <span style={{ flexShrink: 0 }}>{LEVEL_ICONS[e.level] ?? '·'}</span>
            {e.agentId && (
              <span
                style={{
                  color: '#00e5ff',
                  opacity: 0.7,
                  flexShrink: 0,
                  fontSize: 10,
                  paddingTop: 1,
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                [{e.agentId.replace('apex-', '').replace('-001', '')}]
              </span>
            )}
            <span style={{ color: LEVEL_COLORS[e.level] ?? '#e2e8f0', wordBreak: 'break-word', flex: 1 }}>
              {e.message}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
      <div ref={bottomRef} />
    </div>
  );
}
