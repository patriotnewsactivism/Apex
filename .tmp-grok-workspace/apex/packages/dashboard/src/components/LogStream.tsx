import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, Download } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useWebSocket, type ApexEvent } from '../hooks/useWebSocket.js';
import { copyText, downloadText, fileStamp } from '../lib/clipboard.js';

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

/** One log line as plain text: the shape you would paste into an issue or a
 *  chat. Deliberately not JSON — the point is that a human can read it and a
 *  model can parse it without ceremony. */
function toPlainText(entries: DisplayLog[]): string {
  const stamp = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  return entries
    .map((e) => `${stamp(e.timestamp)}  ${e.level.toUpperCase().padEnd(8)} ${e.agentId ? `[${e.agentId}] ` : ''}${e.message}`)
    .join('\n');
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

  const [copied, setCopied] = useState(false);

  const copyLogs = useCallback(async () => {
    await copyText(toPlainText(merged));
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }, [merged]);

  const downloadLogs = useCallback(() => {
    downloadText(`apex-log-${fileStamp()}.log`, toPlainText(merged));
  }, [merged]);

  return (
    <div style={{ height: '100%', maxWidth: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        className="apex-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--color-apex-line)',
          flexShrink: 0,
        }}
      >
        <span className="apex-eyebrow">{merged.length} entries</span>
        <div style={{ flex: 1, minWidth: 0 }} />
        <button
          className="btn-secondary apex-tap"
          onClick={copyLogs}
          disabled={merged.length === 0}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }}
          title="Copy the whole feed as plain text"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          className="btn-secondary apex-tap"
          onClick={downloadLogs}
          disabled={merged.length === 0}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }}
          title="Download the feed as a .log file"
        >
          <Download size={13} /> Save
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          maxWidth: '100%',
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
              maxWidth: '100%',
              minWidth: 0,
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
            <span
              style={{
                color: LEVEL_COLORS[e.level] ?? '#e2e8f0',
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
                whiteSpace: 'pre-wrap',
                flex: 1,
                minWidth: 0,
                maxWidth: '100%',
              }}
            >
              {e.message}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
