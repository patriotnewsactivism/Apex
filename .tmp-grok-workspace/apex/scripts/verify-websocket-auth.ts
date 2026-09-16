import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  consumeWebSocketTicket,
  issueWebSocketTicket,
} from '../packages/api-server/src/websocket-auth.js';

const valid = issueWebSocketTicket(1_000);
assert.equal(consumeWebSocketTicket(valid, 1_001), true, 'fresh ticket must authenticate');
assert.equal(consumeWebSocketTicket(valid, 1_002), false, 'ticket replay must fail');

const expired = issueWebSocketTicket(2_000);
assert.equal(consumeWebSocketTicket(expired, 32_001), false, 'expired ticket must fail');
assert.equal(consumeWebSocketTicket(null), false, 'missing ticket must fail');

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

const serverSource = readFileSync(join(repositoryRoot, 'packages/api-server/src/websocket.ts'), 'utf8');
assert.match(serverSource, /type: 'heartbeat'/, 'server must send an observable browser heartbeat');

console.log('✅ WEBSOCKET AUTH AND HEARTBEAT GUARDS PASSED');
