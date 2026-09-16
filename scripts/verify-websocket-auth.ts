import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
<<<<<<< ours
<<<<<<< ours
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
=======
=======
>>>>>>> theirs
import { issueWebSocketTicket, validateWebSocketTicket } from '../packages/api-server/src/websocket-auth.js';

process.env.APEX_ADMIN_TOKEN = 'test-only-websocket-signing-key';
const valid = issueWebSocketTicket(1_000);
assert.equal(validateWebSocketTicket(valid, 1_001), true, 'fresh ticket must authenticate');

const expired = issueWebSocketTicket(2_000);
assert.equal(validateWebSocketTicket(expired, 32_001), false, 'expired ticket must fail');
assert.equal(validateWebSocketTicket(null), false, 'missing ticket must fail');
assert.equal(validateWebSocketTicket(`${valid.slice(0, -1)}x`, 1_001), false, 'tampered ticket must fail');

const originalKey = process.env.APEX_ADMIN_TOKEN;
process.env.APEX_ADMIN_TOKEN = 'different-instance-key';
assert.equal(validateWebSocketTicket(valid, 1_001), false, 'ticket signed by another deployment must fail');
process.env.APEX_ADMIN_TOKEN = originalKey;
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

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
<<<<<<< ours
<<<<<<< ours
=======
assert.doesNotMatch(serverSource, /\bas any\b/, 'WebSocket liveness must remain type-safe');
>>>>>>> theirs
=======
assert.doesNotMatch(serverSource, /\bas any\b/, 'WebSocket liveness must remain type-safe');
>>>>>>> theirs

console.log('✅ WEBSOCKET AUTH AND HEARTBEAT GUARDS PASSED');
