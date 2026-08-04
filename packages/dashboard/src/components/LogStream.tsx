import { useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useWebSocket, type ApexEvent } from '../hooks/useWebSocket.js';

const LEVEL_COLORS: Record<string, string> = {
  debug: '#64748b',
  info: '#e2e8f0',
  warn: '#c9a84a',
  error: '#c45c66',
  thinking: '#5a9eae',
  acting: '#8b7ec8',
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

interface DisplayLog {
  timestamp: number;
  agentId?: string;
  level: string;
  message: string;
}

export function LogStream() {
  const { events } = useWebSocket();
  const bottomRef = useRef<HTMLDivElement>(null);

  // REST API fallback — fetches persisted logs every 5s. This ensures the
  // stream shows content even when the WebSocket isn't connected or no live
  // events are flowing. (The previous Convex query was fetched but never
  // rendered, and could crash the component if the Convex deployment wasn't
  // synced.)
  const { data: restLogs = [] } = useQuery({
    queryKey: ['logs'],
    queryFn: () => api.logs.list(200),
    refetchInterval: 5_000,
  });

  // Live WebSocket log events
  const wsLogs = useMemo(
    () => events.filter((e) => e.type === 'log') as Extract<ApexEvent, { type: 'log' }>[],
    [events],
  );

  // Merge: REST logs as the historical base, then live WS events that are
  // newer than the newest REST log (avoiding duplicates).
  const merged = useMemo<DisplayLog[]>(() => {
    const restMapped: DisplayLog[] = restLogs.map((l) => ({
      timestamp: new Date(l.timestamp).getTime(),
      agentId: l.agentId ?? undefined,
      level: l.level,
      message: l.message,
    }));

    if (restMapped.length === 0) {
      // No REST logs — show all WS events
      return wsLogs.map((e) => ({ timestamp: e.timestamp, agentId: e.agentId, level: e.level, message: e.message }));
    }

    const newestRestTs = Math.max(...restMapped.map((l) => l.timestamp));
    const liveOnly = wsLogs
      .filter((e) => e.timestamp > newestRestTs)
      .map((e) => ({ timestamp: e.timestamp, agentId: e.agentId, level: e.level, message: e.message }));

    return [...restMapped, ...liveOnly].slice(-500);
  }, [restLogs, wsLogs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [merged.length]);

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
      {merged.length === 0 && (
        <div style={{ color: 'var(--color-apex-muted)', textAlign: 'center', marginTop: 40 }}>
          Waiting for agent activity...
        </div>
      )}
      <AnimatePresence initial={false}>
        {merged.map((e, i) => (
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
                  color: '#5a9eae',
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
