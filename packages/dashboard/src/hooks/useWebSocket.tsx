import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApexEvent =
  | { type: 'connected'; timestamp: number }
  | { type: 'heartbeat'; timestamp: number }
  | { type: 'agent:status'; agentId: string; status: string; message?: string }
  | { type: 'task:created'; taskId: string; title: string; assignedAgentId?: string }
  | { type: 'task:updated'; taskId: string; status: string; result?: string }
  | { type: 'goal:created'; goalId: string; title: string }
  | { type: 'goal:updated'; goalId: string; status: string }
  | { type: 'log'; agentId?: string; taskId?: string; level: string; message: string; timestamp: number }
  | { type: 'approval:requested'; approvalId: string; agentId: string; toolName: string; reason: string }
  | { type: 'approval:resolved'; approvalId: string; status: string }
  | { type: 'memory:updated'; agentId: string; key: string }
  | { type: 'campaign:started'; campaignId: string; name: string; targetLeads: number; segments: number }
  | { type: 'campaign:progress'; campaignId: string; leadsSaved: number; targetLeads: number; segmentsDone: number; segmentsTotal: number }
  | { type: 'campaign:segment'; campaignId: string; segmentId: string; industry: string; city: string; status: string; saved: number; found: number }
  | { type: 'campaign:completed'; campaignId: string; status: string; leadsSaved: number; targetLeads: number };

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
const HEARTBEAT_TIMEOUT = 75_000;

function getWsUrl(ticket: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname === 'localhost' ? 'localhost:5000' : window.location.host;
  const base = `${protocol}//${host}/ws`;
  return `${base}?ticket=${encodeURIComponent(ticket)}`;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ApexEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<ApexEvent | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_DELAY);
  const intentionalClose = useRef(false);

  const cleanupHeartbeat = () => {
    if (heartbeatTimeout.current) clearTimeout(heartbeatTimeout.current);
    heartbeatTimeout.current = null;
  };

  // The event stream only contains status CHANGES. A browser that connects
  // after agents are already thinking/acting otherwise starts with an empty
  // status map and incorrectly renders 0 active agents until another transition
  // happens. Bootstrap from the authoritative in-memory statuses returned by
  // /api/agents, then let websocket events win for any status that changes while
  // the snapshot request is in flight.
  const hydrateAgentStatuses = async () => {
    try {
      const agents = await api.agents.list();
      const snapshot = Object.fromEntries(
        agents.map((agent) => [agent.id, agent.liveStatus ?? agent.status ?? 'idle']),
      );
      setAgentStatuses((liveUpdates) => ({ ...snapshot, ...liveUpdates }));
    } catch (err) {
      console.warn(
        '[WebSocket] Could not hydrate initial agent statuses:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const connect = async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    // Close any stale socket before replacing it so we don't leak handlers.
    if (wsRef.current) {
      intentionalClose.current = true;
      wsRef.current.close();
    }

    let ticket: string;
    try {
      ({ ticket } = await api.auth.websocketTicket());
    } catch {
      scheduleReconnect();
      return;
    }

    const ws = new WebSocket(getWsUrl(ticket));
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay.current = INITIAL_RECONNECT_DELAY;
      // Drop statuses from an older connection, then immediately replace them
      // with a fresh server snapshot. Any websocket transition arriving during
      // the fetch is merged on top of that snapshot by hydrateAgentStatuses().
      setAgentStatuses({});
      void hydrateAgentStatuses();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }

      // The server sends an observable application heartbeat every 30 seconds.
      cleanupHeartbeat();
      resetHeartbeatWatchdog(ws);
    };

    ws.onmessage = (e) => {
      // Reset the heartbeat timeout whenever any message arrives.
      resetHeartbeatWatchdog(ws);
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
      scheduleReconnect();
    };
  };

  const resetHeartbeatWatchdog = (ws: WebSocket) => {
    if (heartbeatTimeout.current) clearTimeout(heartbeatTimeout.current);
    heartbeatTimeout.current = setTimeout(() => {
      console.warn('[WebSocket] No heartbeat received; forcing reconnect');
      ws.close();
    }, HEARTBEAT_TIMEOUT);
  };

  const scheduleReconnect = () => {
    if (reconnectTimer.current) return;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, MAX_RECONNECT_DELAY);
      void connect();
    }, reconnectDelay.current);
  };

  useEffect(() => {
    void connect();
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
