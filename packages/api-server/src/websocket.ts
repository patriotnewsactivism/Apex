import { WebSocketServer, WebSocket } from 'ws';
import { apexEventBus } from '@workspace/core';
import type { ApexEvent } from '@workspace/core';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { consumeWebSocketTicket } from './websocket-auth.js';

// ─── WebSocket Broadcast Service ──────────────────────────────────────────────

const clients = new Set<WebSocket>();

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Browser WebSockets cannot set Authorization headers. Accept only the
    // short-lived, single-use ticket minted by the authenticated HTTP route;
    // never put the long-lived admin token in a URL.
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!consumeWebSocketTicket(url.searchParams.get('ticket'))) {
      ws.close(1008, 'Invalid or expired ticket');
      return;
    }

    clients.add(ws);
    console.log(`📡 WebSocket client connected (total: ${clients.size})`);

    // Send current system status on connect
    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));

    // Send an application-level heartbeat as well as a protocol ping. Browser
    // JavaScript cannot observe ping frames, so the dashboard needs this small
    // message to distinguish a quiet healthy connection from a dead proxy.
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
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
