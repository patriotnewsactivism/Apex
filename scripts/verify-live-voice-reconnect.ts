/**
 * Guard: the live-voice Deepgram session reconnects with exponential backoff
 * + jitter on a dropped connection (network blip, or a transient Groq 429 —
 * FAILED_TO_THINK) instead of ending the call, and stays silent to the
 * client while retrying so a same-second reconnect doesn't flip the UI to an
 * error state before it even gets a chance to succeed.
 *
 * Direct execution of the pure backoff function, plus source-structural
 * checks for the reconnect wiring (no live Deepgram/Groq account in CI).
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

async function main(): Promise<void> {
  console.log('Verifying live-voice Deepgram reconnect handling...\n');

  const source = read('packages/api-server/src/live-voice.ts');
  const geminiSource = read('packages/api-server/src/gemini-live-session.ts');

  // ── Pure helper: run it, don't just read it ──────────────────────────────
  const mod = (await import(
    path.join(root, 'packages/api-server/src/live-voice.ts')
  )) as typeof import('../packages/api-server/src/live-voice.js');
  const { reconnectDelayMs, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_MAX_ATTEMPTS } = mod;

  check(
    'the first retry is capped at the base delay (attempt 0, random()=1 -> exactly the base)',
    reconnectDelayMs(0, () => 1) === RECONNECT_BASE_DELAY_MS,
    reconnectDelayMs(0, () => 1),
  );
  check(
    'zero jitter draw means an immediate retry, not a stuck wait',
    reconnectDelayMs(0, () => 0) === 0,
  );
  check(
    'each attempt doubles the cap (attempt 2 -> 4x the base)',
    reconnectDelayMs(2, () => 1) === RECONNECT_BASE_DELAY_MS * 4,
    reconnectDelayMs(2, () => 1),
  );
  check(
    'the exponential curve stops growing once it hits the max delay, so a long outage does not wait longer and longer forever',
    reconnectDelayMs(10, () => 1) === RECONNECT_MAX_DELAY_MS,
    reconnectDelayMs(10, () => 1),
  );
  check(
    'jitter is genuinely applied, not just a passthrough of the cap',
    reconnectDelayMs(3, () => 0.5) === Math.round(RECONNECT_BASE_DELAY_MS * 8 * 0.5),
    reconnectDelayMs(3, () => 0.5),
  );
  check(
    'a negative attempt index cannot produce a negative exponent (defensive floor at attempt 0)',
    reconnectDelayMs(-5, () => 1) === RECONNECT_BASE_DELAY_MS,
    reconnectDelayMs(-5, () => 1),
  );
  check(
    'the retry budget is bounded, not unlimited (a dead credential would otherwise retry forever)',
    RECONNECT_MAX_ATTEMPTS > 0 && RECONNECT_MAX_ATTEMPTS <= 10,
    RECONNECT_MAX_ATTEMPTS,
  );

  // ── Reconnect is actually wired to fire, not just defined ────────────────
  check(
    'the Deepgram connection is behind a reusable connect function, not a one-shot inline call',
    /const connectToDeepgram = \(\) => \{/.test(source),
  );
  check(
    'a dropped connection schedules a reconnect via the backoff function, not a fixed delay',
    /const delay = reconnectDelayMs\(reconnectAttempt\);/.test(source) &&
      /reconnectTimer = setTimeout\(\(\) => \{/.test(source) &&
      /if \(client\.readyState === WebSocket\.OPEN && !intentionallyClosed\) connectToDeepgram\(\);/.test(source),
  );
  check(
    'exhausting the retry budget gives up instead of retrying forever',
    /if \(reconnectAttempt >= RECONNECT_MAX_ATTEMPTS\) \{/.test(source),
  );
  check(
    'a normal (code 1000) or intentional close never triggers a reconnect',
    /if \(intentionallyClosed \|\| code === 1000\) \{/.test(source),
  );
  check(
    'a successful (re)connection resets the attempt counter, so a later drop gets the full retry budget again',
    /case 'SettingsApplied':\s*\n\s*agentReady = true;\s*\n[\s\S]{0,400}reconnectAttempt = 0;/.test(source),
  );

  // ── The actual bug this exists to avoid: telling the client "error"
  //    immediately would flip the UI to an error state before a same-second
  //    reconnect even gets a chance to succeed. Only the final give-up path
  //    (gated on the attempt budget) may do that. ────────────────────────────
  const dgErrorHandler = source.slice(
    source.indexOf("dg.on('error',"),
    source.indexOf("dg.on('close',"),
  );
  check(
    "Deepgram's transport-level 'error' event does not immediately notify the client",
    // Checks for an actual call (the open paren), not just the identifier —
    // otherwise a comment explaining that it does NOT call safeSendClient
    // would itself trip this check by mentioning the name.
    dgErrorHandler.length > 0 && !dgErrorHandler.includes('safeSendClient('),
  );
  const applicationErrorCase = source.slice(
    source.indexOf("case 'Error': {"),
    source.indexOf("default:"),
  );
  check(
    "Deepgram's application-level 'Error' event (e.g. FAILED_TO_THINK) does not immediately notify the client either",
    applicationErrorCase.length > 0 && !applicationErrorCase.includes('safeSendClient('),
  );
  check(
    'the close handler is the single place that decides retry vs. give-up, and only it notifies the client on give-up',
    /if \(reconnectAttempt >= RECONNECT_MAX_ATTEMPTS\) \{\s*\n\s*safeSendClient\(\{/.test(source),
  );

  // ── A real hang-up must never leave a zombie reconnect timer running ──────
  check(
    'the client-close handler marks the disconnect intentional so a same-moment Deepgram close is never retried',
    /client\.on\('close', \(\) => \{[\s\S]{0,80}intentionallyClosed = true;/.test(source),
  );
  check(
    'the client-close handler cancels any pending reconnect timer',
    /client\.on\('close', \(\) => \{[\s\S]{0,200}clearReconnectTimer\(\);/.test(source),
  );

  // ── Reconnects stay context-aware instead of forgetting where Don is ─────
  check(
    'a mid-call screen navigation is remembered so a reconnect\'s fresh prompt reflects it, not just the call-start page',
    /currentPageNote = `\\n\\nDon's current screen: \$\{msg\.text\}`;/.test(source),
  );


  // ── Gemini -> Deepgram mid-call continuity ────────────────────────────────
  check(
    'Gemini exposes a mid-call failover callback carrying buffered mic audio and live context',
    /onFailover\?: \(state: GeminiLiveFailoverState\) => void;/.test(geminiSource) &&
      /bufferedAudio: bufferedAudio\.slice\(-MAX_BUFFERED_AUDIO_FRAMES\)/.test(geminiSource) &&
      /lastSpeechStartedAt,/.test(geminiSource) &&
      /currentPageNote,/.test(geminiSource),
  );
  check(
    'a failed Gemini resume setup consumes the remaining retry budget instead of immediately ending the call',
    /connect\(sessionHandle\)\.then\(\(ok\) => \{[\s\S]{0,180}if \(!ok\) \{[\s\S]{0,120}scheduleReconnect\('Gemini Live resume setup failed'\)/.test(geminiSource),
  );
  check(
    'exhausting Gemini resume attempts hands the live browser call to the fallback instead of closing it',
    /if \(reconnectAttempts >= RECONNECT_MAX_ATTEMPTS\) \{\s*failoverToDeepgram\(reason\);/.test(geminiSource) &&
      /onFailover\(\{[\s\S]{0,300}bufferedAudio:/.test(geminiSource),
  );
  check(
    'provider handoff flushes queued Gemini playback before Deepgram can speak',
    /safeSendClient\(\{ type: 'interrupted' \}\);[\s\S]{0,180}if \(onFailover\)/.test(geminiSource),
  );
  check(
    'live-voice wires Gemini mid-call failure into the existing Deepgram session without returning after Gemini starts',
    /onFailover: \(state\) => \{[\s\S]{0,160}activateDeepgramFallback\?\.\(state\)/.test(source) &&
      /if \(geminiStarted\) \{\s*console\.log\('🎙️  Live voice client connected via Gemini 3\.8 Live'\);\s*\} else \{/.test(source) &&
      /activateDeepgramFallback = \(handoff\?: GeminiLiveFailoverState\)/.test(source),
  );
  check(
    'Deepgram ignores browser mic events until fallback is actually active, preventing duplicate Gemini+Deepgram ingestion',
    /client\.on\('message', \(raw, isBinary\) => \{\s*if \(!deepgramActive \|\| isBinary\) return;/.test(source),
  );
  check(
    'fallback credentials are validated before deepgramActive is set, so unavailable fallback cannot clean up an uninitialized socket',
    source.indexOf("if (!deepgramKey || !groqKey) {", source.indexOf('activateDeepgramFallback =')) <
      source.indexOf('deepgramActive = true;', source.indexOf('activateDeepgramFallback =')),
  );

  if (failures > 0) {
    console.error(`\n${failures} live-voice-reconnect check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll live-voice-reconnect checks passed.');
}

main();
