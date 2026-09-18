/**
 * Guard: Don's chat surface (APEX Command) gets interactive priority on the
 * LLM budget and never leaks a raw internal capacity-pause string into the
 * chat window.
 *
 * Source-structural only (no live LLM/DB calls) — safe on every pull request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

console.log("Verifying Don's chat surface capacity handling...\n");

const chat = read('packages/api-server/src/routes/chat.ts');
const types = read('packages/core/src/types.ts');
const clientSource = read('packages/core/src/llm-client.ts');

// ── A human typing one message at a time cannot cause the burn-loop the
//    smoothing ramp exists to prevent, so chat gets priority over pacing ──
check(
  'LLMExecutionContext declares the interactive flag',
  /interactive\?:\s*boolean;/.test(types),
);
check(
  "chat.ts's LLM call is marked interactive, not routed like a background agent",
  /llm\.complete\(llmHistory, CHAT_TOOLS, \{[\s\S]{0,180}?role: 'CEO',[\s\S]{0,120}?interactive: true,[\s\S]{0,120}?conversationId/.test(chat),
);
check(
  'the interactive flag actually reaches the capacity checks in complete(), not just the type',
  /const pacingOverride = execution\?\.interactive \? false : undefined;/.test(clientSource),
);

// ── The bypass is scoped to pacing only — the hard caps and the per-minute
//    provider rate limit must still apply to an interactive call the same as
//    to any other, or "give chat priority" quietly becomes "let chat ignore
//    the budget entirely". ─────────────────────────────────────────────────
check(
  'the all-provider emergency hard cap is checked independently of the interactive pacing override',
  /const emergencyWindow = emergencyRequestCapacityWindow\(Date\.now\(\)\);/.test(clientSource) &&
    /if \(!emergencyWindow\.allowed\) \{/.test(clientSource),
);
check(
  'each provider still receives a hard-cap/rate-window check even for interactive chat',
  /requestWindowForProvider\([\s\S]{0,100}?provider,[\s\S]{0,100}?pacingOverride/.test(clientSource),
);
check(
  'requestCapacityWindow() itself still runs its per-minute rate-limit check regardless of the pacing override (request-ledger.ts, unconditional after the daily/pacing branch)',
  /const resumeAt = rateLimitResumeAt\(at\);/.test(read('packages/core/src/request-ledger.ts')),
);

// ── Don a genuine pause still happens (hard cap actually reached), chat.ts
//    must translate it, not forward the raw "APEX LLM capacity paused..."
//    string to the chat window. ──────────────────────────────────────────
check(
  'chat.ts imports the pause recognizer instead of pattern-matching errors itself',
  /import \{ createLLMClient, getDefaultLLMConfig, getLLMCapacityResumeAt, isLLMIntentionalPause \} from '@workspace\/core';/.test(chat),
);
check(
  "a genuine capacity pause is caught and answered conversationally, not as a 500 with the raw message",
  /if \(isLLMIntentionalPause\(message\)\) \{/.test(chat) &&
    /return res\.json\(\{\s*reply: resumeClock/.test(chat),
);
check(
  'the friendly reply never echoes the raw internal pause string back to Don',
  !/reply: message/.test(chat) && !/reply: err\.message/.test(chat),
);
check(
  'a non-pause error still falls through to the existing 500 handling (this is a narrow carve-out, not a blanket catch-all)',
  /console\.error\('\[chat\] POST \/message error:', err\);\s*\n\s*return res\.status\(500\)\.json\(\{ error: message \}\);/.test(chat),
);

if (failures > 0) {
  console.error(`\n${failures} chat-capacity-handling check(s) failed.`);
  process.exit(1);
}
console.log('\nAll chat-capacity-handling checks passed.');
