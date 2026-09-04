import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { consumeWebSocketTicket } from './websocket-auth.js';

type ConnectionHandler = (socket: WebSocket, request: IncomingMessage) => void;

interface UpgradeRoute {
  server: WebSocketServer;
  onConnection: ConnectionHandler;
}

interface UpgradeRouter {
  routes: Map<string, UpgradeRoute>;
}

const routers = new WeakMap<Server, UpgradeRouter>();

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string, reason: string): void {
  console.warn(`[websocket] Upgrade rejected: ${reason}`);
  if (socket.destroyed) return;

  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(statusText)}\r\n` +
      `\r\n${statusText}`,
  );
}

function getRouter(httpServer: Server): UpgradeRouter {
  const existing = routers.get(httpServer);
  if (existing) return existing;

  const router: UpgradeRouter = { routes: new Map() };
  routers.set(httpServer, router);

  // This is deliberately the only HTTP upgrade listener installed by APEX.
  // Each WebSocketServer is `noServer`, so `ws` owns the RFC 6455 handshake
  // exactly once after path and ticket authentication have succeeded.
  httpServer.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request', 'malformed URL');
      return;
    }

    const route = router.routes.get(url.pathname);
    if (!route) {
      rejectUpgrade(socket, 404, 'Not Found', 'unknown path');
      return;
    }

    if (!consumeWebSocketTicket(url.searchParams.get('ticket'))) {
      rejectUpgrade(socket, 401, 'Unauthorized', `invalid ticket for ${url.pathname}`);
      return;
    }

    console.log(`[websocket] Upgrade accepted: ${url.pathname}`);
    route.server.handleUpgrade(request, socket, head, (webSocket) => {
      route.onConnection(webSocket, request);
    });
  });

  return router;
}

/** Register an authenticated native RFC 6455 endpoint on the shared server. */
export function registerWebSocketRoute(
  httpServer: Server,
  path: string,
  onConnection: ConnectionHandler,
): WebSocketServer {
  const router = getRouter(httpServer);
  if (router.routes.has(path)) {
    throw new Error(`WebSocket route already registered: ${path}`);
  }

  // Compression is intentionally disabled while diagnosing intermediary frame
  // corruption. It also avoids negotiating an extension the dashboard does not
  // need for these small event messages.
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  router.routes.set(path, { server: webSocketServer, onConnection });
  webSocketServer.on('close', () => router.routes.delete(path));
  return webSocketServer;
}
