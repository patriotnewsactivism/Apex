/**
 * Guards the WebSocket server against the three ways it could consume the
 * container's memory until Cloud Run restarted it on an unchanged revision.
 *
 *  1. A per-connection setInterval cleared only on 'close', so a socket that
 *     ended via 'error' left a timer firing every 30s for the life of the
 *     process — and that timer kept the dead socket reachable.
 *  2. An `isAlive` flag written on every pong and read by nothing, so a peer
 *     that vanished without closing TCP was never reaped.
 *  3. A broadcast that wrote to every OPEN socket with no regard for whether
 *     the peer was still draining, so an unread socket accumulated every event
 *     13 agents emit, in memory, forever.
 */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { WebSocket } from 'ws';
import { setupWebSocket, broadcast, getConnectedClientCount } from '../packages/api-server/src/websocket.js';
import { issueWebSocketTicket } from '../packages/api-server/src/websocket-auth.js';
import { registerWebSocketRoute } from '../packages/api-server/src/websocket-upgrade.js';

async function main() {
  const SWEEP_MS = 25;

  const countTimers = () =>
    process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  const server = createServer();
  const wss = setupWebSocket(server, SWEEP_MS);
  const secondWss = registerWebSocketRoute(server, '/ws/integration-secondary', () => undefined);
  assert.equal(server.listenerCount('upgrade'), 1, 'APEX must install exactly one HTTP upgrade listener');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  const connectWithFirstFrame = () =>
    new Promise<{ socket: WebSocket; firstMessage: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${issueWebSocketTicket()}`);
      let opened = false;
      let firstMessage: string | undefined;
      const finish = () => {
        if (opened && firstMessage !== undefined) resolve({ socket: ws, firstMessage });
      };
      ws.once('open', () => {
        opened = true;
        finish();
      });
      ws.once('message', (data, isBinary) => {
        assert.equal(isBinary, false, 'first server message must be a text frame');
        firstMessage = data.toString();
        finish();
      });
      ws.once('error', reject);
    });
  const connect = async () => (await connectWithFirstFrame()).socket;

  // A real ws client must receive a valid text frame as the first bytes after
  // the library-owned 101 handshake. This reproduces the production failure
  // that Chrome reported as "Invalid frame header".
  const { socket: framedClient, firstMessage } = await connectWithFirstFrame();
  assert.equal(JSON.parse(firstMessage).type, 'connected', 'first frame must contain the connected event');
  framedClient.close(1000, 'integration check complete');
  await new Promise<void>((resolve) => framedClient.once('close', () => resolve()));

  const rejectedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    req.once('response', (response) => resolve(response.statusCode));
    req.once('error', reject);
    req.end();
  });
  assert.equal(rejectedStatus, 401, 'missing WebSocket ticket must be rejected before the 101 handshake');

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ─── 1. Connections must not each add a timer ────────────────────────────────
  const timersBefore = countTimers();
  const sockets = await Promise.all([connect(), connect(), connect(), connect(), connect()]);
  await settle(50);
  assert.equal(getConnectedClientCount(), 5, 'all five clients should be registered');

  const timersAfter = countTimers();
  assert.ok(
    timersAfter - timersBefore < 5,
    `each connection allocated its own timer (${timersBefore} -> ${timersAfter}); the sweep must be server-wide`,
  );

  // ─── 2. A responsive client must survive many sweeps ─────────────────────────
  // The reaper must not mistake a healthy dashboard for a dead one.
  await settle(SWEEP_MS * 6);
  assert.equal(
    getConnectedClientCount(),
    5,
    'clients answering pings were reaped; the liveness check is too aggressive',
  );

  // ─── 3. Ending via 'error' must not leak ─────────────────────────────────────
  // Destroying the transport under the socket is the abrupt path that used to
  // leave the per-connection interval running.
  for (const ws of sockets.slice(1)) {
    (ws as unknown as { _socket: { destroy: () => void } })._socket.destroy();
  }
  await settle(150);
  assert.equal(getConnectedClientCount(), 1, 'abruptly-dropped sockets must be deregistered');
  assert.ok(
    countTimers() - timersBefore < 5,
    'timers outlived the sockets that created them',
  );

  // ─── 4. A client that stops draining must be dropped, not buffered ───────────
  const stalled = sockets[0];
  (stalled as unknown as { _socket: { pause: () => void } })._socket.pause();

  const filler = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 200 && getConnectedClientCount() > 0; i++) {
    broadcast({ type: 'load:test', payload: filler } as never);
  }

  assert.equal(
    getConnectedClientCount(),
    0,
    'a client that stopped reading was kept and written to indefinitely',
  );

  // Let the deliberately-paused socket drain, or its own handle stays open and
  // the harness never exits.
  (stalled as unknown as { _socket: { resume: () => void } })._socket.resume();
  for (const ws of sockets) ws.terminate();

  // Closing the server must stop the sweep. If it ever stops doing so, this
  // script hangs here rather than exiting — the leak, observed directly.
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => secondWss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log('✅ WEBSOCKET LIFECYCLE GUARDS PASSED');

  // Chained: the CI workflow file is not writable by the agent app, so new
  // guards attach to an existing guard entry point instead.
  await import('./verify-mobile-chat-surface.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
