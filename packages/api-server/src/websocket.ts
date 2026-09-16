import { WebSocket } from 'ws';
import { apexEventBus } from '@workspace/core';
import type { ApexEvent } from '@workspace/core';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { registerWebSocketRoute } from './websocket-upgrade.js';

// ─── WebSocket Broadcast Service ──────────────────────────────────────────────

const clients = new Set<WebSocket>();

const HEARTBEAT_INTERVAL_MS = 30_000;

// A client that has stopped reading — laptop asleep, phone off the network, a
// proxy that dropped the connection without sending a FIN — still accepts
// writes, into an in-process buffer that nothing ever drains. Thirteen agents
// emit events continuously, so that buffer grows until the container is killed
// for exceeding its memory limit. Past this much unflushed data the peer is
// treated as gone; dropping one stalled dashboard is far cheaper than losing
// the whole workforce, and the dashboard reconnects on its own.
const MAX_BUFFERED_BYTES = 1_000_000;

// Liveness is tracked in a WeakSet rather than a Map or a property on the
// socket so that a forgotten entry cannot itself become the leak: when the
// socket is collected the entry disappears with it.
const alive = new WeakSet<WebSocket>();

/** Write to one client, dropping it if it has stopped draining. */
function sendTo(client: WebSocket, payload: string): void {
  if (client.readyState !== WebSocket.OPEN) return;

  if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
    console.warn(
      `📡 Dropping unresponsive WebSocket client (${client.bufferedAmount} bytes unflushed)`,
    );
    client.terminate();
    clients.delete(client);
    return;
  }

  client.send(payload);
}

/** `heartbeatIntervalMs` exists so verification can drive the sweep in
 *  milliseconds instead of half-minutes; production always takes the default. */
export function setupWebSocket(
  server: Server,
  heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
) {
  const wss = registerWebSocketRoute(server, '/ws', (ws: WebSocket, _req: IncomingMessage) => {
    clients.add(ws);
    alive.add(ws);
    console.log(`[websocket] Connection opened: /ws (total: ${clients.size})`);

    // Send current system status on connect
    const firstMessage = JSON.stringify({ type: 'connected', timestamp: Date.now() });
    ws.send(firstMessage, (error) => {
      if (error) {
        console.error(`[websocket] First outbound message failed: ${error.message}`);
        return;
      }
      console.log(`[websocket] First outbound message sent: text (${Buffer.byteLength(firstMessage)} bytes)`);
    });

    ws.on('pong', () => {
      alive.add(ws);
    });

    ws.on('close', (code, reason) => {
      clients.delete(ws);
      console.log(
        `[websocket] Connection closed: /ws code=${code} reason=${reason.toString().slice(0, 120) || '(none)'} (total: ${clients.size})`,
      );
    });

    ws.on('error', (err) => {
      console.error(`[websocket] Socket error: /ws: ${err.message}`);
      clients.delete(ws);
    });
  });

  // One sweep for the whole server, not a timer per connection. The per-socket
  // interval this replaces was cleared only in the 'close' handler, so a socket
  // that ended via 'error' left its timer running for the life of the process —
  // firing every 30s forever and keeping the dead socket reachable, so neither
  // was ever collected.
  //
  // The sweep also does what the old `isAlive` flag only pretended to: that
  // flag was set on every pong and never read by anything, so a peer that
  // vanished without closing TCP stayed in `clients` indefinitely.
  const heartbeat = setInterval(() => {
    const payload = JSON.stringify({ type: 'heartbeat', timestamp: Date.now() });

    for (const ws of clients) {
      if (!alive.has(ws)) {
        // Missed the previous round trip. terminate() rather than close():
        // there is no peer left to complete a closing handshake with.
        ws.terminate();
        clients.delete(ws);
        continue;
      }

      alive.delete(ws);
      ws.ping();

      // Browser JavaScript cannot observe ping frames, so the dashboard needs
      // this application-level message to tell a quiet healthy connection from
      // a dead proxy.
      sendTo(ws, payload);
    }
  }, heartbeatIntervalMs);

  wss.on('close', () => clearInterval(heartbeat));

  // Forward all APEX events to connected WebSocket clients
  apexEventBus.on('event', (event: ApexEvent) => {
    broadcast(event);
  });

  return wss;
}

export function broadcast(event: ApexEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    sendTo(client, payload);
  }
}

export function getConnectedClientCount() {
  return clients.size;
}
