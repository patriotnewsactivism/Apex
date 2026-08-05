import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApexEvent =
  | { type: 'connected'; timestamp: number }
  | { type: 'agent:status'; agentId: string; status: string; message?: string }
  | { type: 'task:created'; taskId: string; title: string; assignedAgentId?: string }
  | { type: 'task:updated'; taskId: string; status: string; result?: string }
  | { type: 'goal:created'; goalId: string; title: string }
  | { type: 'goal:updated'; goalId: string; status: string }
  | { type: 'log'; agentId?: string; taskId?: string; level: string; message: string; timestamp: number }
  | { type: 'approval:requested'; approvalId: string; agentId: string; toolName: string; reason: string }
  | { type: 'approval:resolved'; approvalId: string; status: string }
  | { type: 'memory:updated'; agentId: string; key: string };

// ─── WebSocket Context ───────────────────────────────────────────────────────

interface WSContextValue {
  connected: boolean;
  lastEvent: ApexEvent | null;
  events: ApexEvent[];
  agentStatuses: Record<string, string>;
}

const WSContext = createContext<WSContextValue>({
  connected: false,
  lastEvent: null,
  events: [],
  agentStatuses: {},
});

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const HEARTBEAT_INTERVAL = 25_000;
const HEARTBEAT_TIMEOUT = 15_000;

function getWsUrl(): string {
  const token = localStorage.getItem('apex_token');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname === 'localhost' ? 'localhost:5000' : window.location.host;
  const base = `${protocol}//${host}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ApexEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<ApexEvent | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_DELAY);
  const intentionalClose = useRef(false);

  const cleanupHeartbeat = () => {
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    heartbeatTimer.current = null;
    if (heartbeatTimeout.current) clearTimeout(heartbeatTimeout.current);
    heartbeatTimeout.current = null;
  };

  const connect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Close any stale socket before replacing it so we don't leak handlers.
    if (wsRef.current) {
      intentionalClose.current = true;
      wsRef.current.close();
    }

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay.current = INITIAL_RECONNECT_DELAY;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }

      // Server sends pings; client responds with pongs automatically. We also
      // expect an occasional message. If nothing arrives, force reconnect.
      cleanupHeartbeat();
      heartbeatTimer.current = setInterval(() => {
        heartbeatTimeout.current = setTimeout(() => {
          console.warn('[WebSocket] No message received within heartbeat window; forcing reconnect');
          ws.close();
        }, HEARTBEAT_TIMEOUT);
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (e) => {
      // Reset the heartbeat timeout whenever any message arrives.
      if (heartbeatTimeout.current) clearTimeout(heartbeatTimeout.current);
      try {
        const event = JSON.parse(e.data) as ApexEvent;
        setLastEvent(event);

        // Update agent statuses
        if (event.type === 'agent:status') {
          setAgentStatuses((prev) => ({ ...prev, [event.agentId]: event.status }));
        }

        // Keep last 500 events
        setEvents((prev) => {
          const next = [...prev, event];
          return next.length > 500 ? next.slice(-500) : next;
        });
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      setConnected(false);
      cleanupHeartbeat();
      if (intentionalClose.current) {
        intentionalClose.current = false;
        return;
      }
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, MAX_RECONNECT_DELAY);
        connect();
      }, reconnectDelay.current);
    };
  };

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      cleanupHeartbeat();
    };
  }, []);

  return (
    <WSContext.Provider value={{ connected, lastEvent, events, agentStatuses }}>
      {children}
    </WSContext.Provider>
  );
}

export function useWebSocket() {
  return useContext(WSContext);
}

/** Subscribe to a specific event type */
export function useApexEvent<T extends ApexEvent['type']>(
  type: T,
  handler: (event: Extract<ApexEvent, { type: T }>) => void,
) {
  const { lastEvent } = useWebSocket();
  useEffect(() => {
    if (lastEvent?.type === type) {
      handler(lastEvent as Extract<ApexEvent, { type: T }>);
    }
  }, [lastEvent]);
}
