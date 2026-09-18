import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  consumeWebSocketTicket,
  forgetLocalWebSocketTicket,
  issueWebSocketTicket,
  provePersistedTicketRoundTrip,
} from '../packages/api-server/src/websocket-auth.js';

process.env.APEX_WEBSOCKET_TICKETS = 'memory';

async function main() {
const valid = await issueWebSocketTicket(1_000);
assert.equal(await consumeWebSocketTicket(valid, 1_001), true, 'fresh ticket must authenticate');
assert.equal(await consumeWebSocketTicket(valid, 1_002), false, 'ticket replay must fail');

const expired = await issueWebSocketTicket(2_000);
assert.equal(await consumeWebSocketTicket(expired, 32_001), false, 'expired ticket must fail');
assert.equal(await consumeWebSocketTicket(null), false, 'missing ticket must fail');

const dropped = await issueWebSocketTicket(5_000);
forgetLocalWebSocketTicket(dropped);
assert.equal(
  await consumeWebSocketTicket(dropped, 5_001),
  false,
  'memory-mode consume after local drop must fail (no Postgres fallback)',
);
const proof = await provePersistedTicketRoundTrip(8_000);
assert.equal(proof.mode, 'memory');
assert.equal(proof.consumedAfterLocalDrop, false, 'memory mode cannot prove a replica hop');
assert.equal(proof.replayRejected, true);

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dashboardSources = [
  'packages/dashboard/src/hooks/useWebSocket.tsx',
  'packages/dashboard/src/hooks/useLiveVoiceCall.ts',
].map((path) => readFileSync(join(repositoryRoot, path), 'utf8')).join('\n');
assert.doesNotMatch(
  dashboardSources,
  /[?&]token=|searchParams\.get\(['"]token['"]\)/,
  'the long-lived admin token must not be embedded in WebSocket URLs',
);
assert.match(dashboardSources, /websocketTicket\(\)/, 'browser must request a short-lived ticket');
assert.match(
  dashboardSources,
  /type === 'heartbeat'/,
  'browser must answer application heartbeats; RFC ping is invisible to JS and may be stripped by the proxy',
);

const serverSource = readFileSync(join(repositoryRoot, 'packages/api-server/src/websocket.ts'), 'utf8');
assert.match(serverSource, /type: 'heartbeat'/, 'server must send an observable browser heartbeat');
assert.match(serverSource, /ws\.on\('message'/, 'server must treat inbound application messages as liveness');

console.log('✅ WEBSOCKET AUTH AND HEARTBEAT GUARDS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
