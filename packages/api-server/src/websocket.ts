import { WebSocketServer, WebSocket } from 'ws';
import { apexEventBus } from '@workspace/core';
import type { ApexEvent } from '@workspace/core';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { validateAdminToken } from './middleware/auth.js';

// ─── WebSocket Broadcast Service ──────────────────────────────────────────────

const clients = new Set<WebSocket>();

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Reject unauthenticated WebSocket connections. Dashboards send the token
    // as a query parameter because browser WebSocket clients cannot set custom
    // headers. We also accept an Authorization header for non-browser clients.
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token') ?? req.headers.authorization;
    if (!validateAdminToken(token || undefined)) {
      ws.close(1008, 'Invalid or missing token');
      return;
    }

    clients.add(ws);
    console.log(`📡 WebSocket client connected (total: ${clients.size})`);

    // Send current system status on connect
    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));

    // Heartbeat: ping the client every 30s and terminate unresponsive sockets.
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on('pong', () => {
      (ws as any).isAlive = true;
    });

    ws.on('close', () => {
      clearInterval(heartbeatInterval);
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
