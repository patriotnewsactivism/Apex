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

// ─── WebSocket Context ────────────────────────────────────────────────────────

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

const RAILWAY_WS_HOST = 'apex-production-731c.up.railway.app';

function getWsUrl(): string {
  const token = localStorage.getItem('apex_token');
  const base = `wss://${RAILWAY_WS_HOST}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ApexEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<ApexEvent | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (e) => {
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
  };

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
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
