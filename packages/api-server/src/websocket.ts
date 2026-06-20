import { WebSocketServer, WebSocket } from 'ws';
import { apexEventBus } from '@workspace/core';
import type { ApexEvent } from '@workspace/core';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';

// ─── WebSocket Broadcast Service ──────────────────────────────────────────────

const clients = new Set<WebSocket>();

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    clients.add(ws);
    console.log(`📡 WebSocket client connected (total: ${clients.size})`);

    // Send current system status on connect
    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`📡 WebSocket client disconnected (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      clients.delete(ws);
    });
  });

  // Forward all APEX events to connected WebSocket clients
  apexEventBus.on('event', (event: ApexEvent) => {
    broadcast(event);
  });

  return wss;
}

export function broadcast(event: ApexEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function getConnectedClientCount() {
  return clients.size;
}
