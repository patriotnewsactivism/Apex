import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { Copy, Check, Download, BookOpen, Terminal, ArrowDown } from 'lucide-react';
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
  info: '•',
  warn: '⚠️',
  error: '❌',
  thinking: '🧠',
  acting: '⚡',
};

const CATEGORY_LABELS: Record<string, string> = {
  lead_search: 'Lead search',
  lead_cleanup: 'List cleanup',
  contact_recovery: 'Contact recovery',
  pipeline: 'Lead pipeline',
  campaign: 'Campaign',
  provider: 'Provider',
  system: 'System',
};

interface DisplayLog {
  key: string;
  timestamp: number;
  agentId?: string;
  level: string;
  message: string;
  category?: string;
  data?: Record<string, unknown> | null;
}

function formatTechnicalTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Chicago',
  });
}

function formatPlainTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'America/Chicago',
  });
}

function toPlainText(entries: DisplayLog[], plainEnglish: boolean): string {
  const stamp = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  return entries
    .map((entry) => {
      if (plainEnglish) {
        const category = entry.category ? `[${CATEGORY_LABELS[entry.category] ?? entry.category}]` : '[Activity]';
        return `${stamp(entry.timestamp)}  ${category} ${entry.message}`;
      }
      return `${stamp(entry.timestamp)}  ${entry.level.toUpperCase().padEnd(8)} ${entry.agentId ? `[${entry.agentId}] ` : ''}${entry.message}`;
    })
    .join('\n');
}

function mapPersistedLog(log: Awaited<ReturnType<typeof api.logs.list>>[number]): DisplayLog {
  return {
    key: `db-${log.id}`,
    timestamp: new Date(log.timestamp).getTime(),
    agentId: log.agentId ?? undefined,
    level: log.level,
    message: log.message,
    category: typeof log.data?.category === 'string' ? log.data.category : undefined,
    data: log.data ?? null,
  };
}

export function LogStream() {
  const { events } = useWebSocket();
  const [mode, setMode] = useState<'plain' | 'technical'>('plain');
  const [copied, setCopied] = useState(false);
  const [followLive, setFollowLive] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // This is intentionally much longer than the old 200-row feed. These rows
  // are outcome summaries APEX explicitly persisted as operator_activity, not
  // every debug line produced by the runtime.
  const { data: activityLogs = [] } = useQuery({
    queryKey: ['logs', 'operator-activity'],
    queryFn: () => api.logs.activity(2000),
    refetchInterval: 5_000,
  });

  // Technical mode stays bounded because raw agent/debug logging is much
  // noisier. It is still available whenever the operator needs exact internals.
  const { data: restLogs = [] } = useQuery({
    queryKey: ['logs', 'technical'],
    queryFn: () => api.logs.list(500),
    refetchInterval: mode === 'technical' ? 5_000 : false,
    enabled: mode === 'technical',
  });

  const wsLogs = useMemo(
    () => events.filter((event) => event.type === 'log') as Extract<ApexEvent, { type: 'log' }>[],
    [events],
  );

  const plainMerged = useMemo<DisplayLog[]>(() => {
    const restMapped = activityLogs.map(mapPersistedLog);
    const newestRestTs = restMapped.length > 0
      ? Math.max(...restMapped.map((entry) => entry.timestamp))
      : 0;

    const liveOnly = wsLogs
      .filter((event) =>
        event.timestamp > newestRestTs &&
        event.data?.kind === 'operator_activity',
      )
      .map((event, index) => ({
        key: `ws-activity-${event.timestamp}-${index}`,
        timestamp: event.timestamp,
        agentId: event.agentId,
        level: event.level,
        message: event.message,
        category: typeof event.data?.category === 'string' ? event.data.category : undefined,
        data: event.data ?? null,
      }));

    return [...restMapped, ...liveOnly].slice(-2000);
  }, [activityLogs, wsLogs]);

  const technicalMerged = useMemo<DisplayLog[]>(() => {
    const restMapped = restLogs.map(mapPersistedLog);
    if (restMapped.length === 0) {
      return wsLogs.slice(-500).map((event, index) => ({
        key: `ws-raw-${event.timestamp}-${index}`,
        timestamp: event.timestamp,
        agentId: event.agentId,
        level: event.level,
        message: event.message,
        data: event.data ?? null,
      }));
    }

    const newestRestTs = Math.max(...restMapped.map((entry) => entry.timestamp));
    const liveOnly = wsLogs
      .filter((event) => event.timestamp > newestRestTs)
      .map((event, index) => ({
        key: `ws-raw-${event.timestamp}-${index}`,
        timestamp: event.timestamp,
        agentId: event.agentId,
        level: event.level,
        message: event.message,
        data: event.data ?? null,
      }));

    return [...restMapped, ...liveOnly].slice(-500);
  }, [restLogs, wsLogs]);

  const visible = mode === 'plain' ? plainMerged : technicalMerged;

  useEffect(() => {
    if (!followLive) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visible.length, mode, followLive]);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setFollowLive(distanceFromBottom < 80);
  }, []);

  const jumpToLive = useCallback(() => {
    setFollowLive(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  const copyLogs = useCallback(async () => {
    await copyText(toPlainText(visible, mode === 'plain'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }, [visible, mode]);

  const downloadLogs = useCallback(() => {
    const suffix = mode === 'plain' ? 'activity' : 'technical';
    downloadText(`apex-${suffix}-${fileStamp()}.log`, toPlainText(visible, mode === 'plain'));
  }, [visible, mode]);

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
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            padding: 2,
            gap: 2,
            background: 'rgba(255,255,255,0.035)',
            border: '1px solid var(--color-apex-line)',
            borderRadius: 6,
          }}
        >
          <button
            onClick={() => setMode('plain')}
            className="apex-tap"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 9px',
              border: 0,
              borderRadius: 4,
              cursor: 'pointer',
              background: mode === 'plain' ? 'var(--color-apex-brass-soft)' : 'transparent',
              color: mode === 'plain' ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
              fontSize: 11,
              fontWeight: 650,
            }}
          >
            <BookOpen size={13} /> Plain English
          </button>
          <button
            onClick={() => setMode('technical')}
            className="apex-tap"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 9px',
              border: 0,
              borderRadius: 4,
              cursor: 'pointer',
              background: mode === 'technical' ? 'rgba(255,255,255,0.06)' : 'transparent',
              color: mode === 'technical' ? 'var(--color-apex-text)' : 'var(--color-apex-muted)',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <Terminal size={13} /> Technical
          </button>
        </div>

        <span className="apex-eyebrow">
          {visible.length.toLocaleString()} {mode === 'plain' ? 'real activity entries' : 'technical entries'}
        </span>
        <div style={{ flex: 1, minWidth: 8 }} />

        <button
          className="btn-secondary apex-tap"
          onClick={copyLogs}
          disabled={visible.length === 0}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 11 }}
          title="Copy the visible history as plain text"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          className="btn-secondary apex-tap"
          onClick={downloadLogs}
          disabled={visible.length === 0}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 11 }}
          title="Save the visible history"
        >
          <Download size={13} /> Save
        </button>
      </div>

      {mode === 'plain' && (
        <div
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--color-apex-line)',
            color: 'var(--color-apex-muted)',
            fontSize: 11,
            lineHeight: 1.45,
            background: 'rgba(201,168,74,0.035)',
          }}
        >
          This feed records completed, measurable actions in everyday language — searches run, records cleaned,
          contacts recovered, prospects moved forward, failures, retries, and campaign results. It is intentionally
          not a stream of AI thoughts or filler.
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          maxWidth: '100%',
          fontFamily: mode === 'plain' ? 'var(--font-sans)' : 'var(--font-mono)',
          fontSize: 12,
          display: 'flex',
          flexDirection: 'column',
          padding: mode === 'plain' ? '8px 12px 18px' : '12px',
        }}
      >
        {visible.length === 0 && (
          <div style={{ color: 'var(--color-apex-muted)', textAlign: 'center', marginTop: 40 }}>
            {mode === 'plain'
              ? 'Waiting for the next verified APEX action…'
              : 'Waiting for technical activity…'}
          </div>
        )}

        {mode === 'plain'
          ? visible.map((entry) => (
              <div
                key={entry.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(112px, auto) 104px minmax(0, 1fr)',
                  gap: 10,
                  alignItems: 'start',
                  padding: '9px 2px',
                  borderBottom: '1px solid rgba(255,255,255,0.045)',
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    color: 'var(--color-apex-muted)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    whiteSpace: 'nowrap',
                    paddingTop: 3,
                  }}
                >
                  {formatPlainTime(entry.timestamp)}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    width: 'fit-content',
                    maxWidth: '100%',
                    padding: '3px 6px',
                    borderRadius: 999,
                    background: entry.level === 'error'
                      ? 'rgba(196,92,102,0.13)'
                      : entry.level === 'warn'
                        ? 'rgba(201,168,74,0.12)'
                        : 'rgba(90,158,174,0.10)',
                    color: entry.level === 'error'
                      ? 'var(--color-apex-red)'
                      : entry.level === 'warn'
                        ? 'var(--color-apex-brass)'
                        : '#7fb5c0',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={CATEGORY_LABELS[entry.category ?? ''] ?? entry.category ?? 'Activity'}
                >
                  {CATEGORY_LABELS[entry.category ?? ''] ?? entry.category ?? 'Activity'}
                </span>
                <span
                  style={{
                    color: entry.level === 'error'
                      ? 'var(--color-apex-red)'
                      : 'var(--color-apex-text)',
                    lineHeight: 1.5,
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                  }}
                >
                  {entry.message}
                </span>
              </div>
            ))
          : visible.map((entry) => (
              <div
                key={entry.key}
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
                  {formatTechnicalTime(entry.timestamp)}
                </span>
                <span style={{ flexShrink: 0 }}>{LEVEL_ICONS[entry.level] ?? '·'}</span>
                {entry.agentId && (
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
                    [{entry.agentId.replace('apex-', '').replace('-001', '')}]
                  </span>
                )}
                <span
                  style={{
                    color: LEVEL_COLORS[entry.level] ?? '#e2e8f0',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                    whiteSpace: 'pre-wrap',
                    flex: 1,
                    minWidth: 0,
                    maxWidth: '100%',
                  }}
                >
                  {entry.message}
                </span>
              </div>
            ))}
        <div ref={bottomRef} />
      </div>

      {!followLive && visible.length > 0 && (
        <button
          onClick={jumpToLive}
          className="btn-secondary apex-tap"
          style={{
            position: 'absolute',
            right: 18,
            bottom: 18,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          <ArrowDown size={13} /> Jump to live
        </button>
      )}
    </div>
  );
}
