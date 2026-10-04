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
  const clientHook = read('packages/dashboard/src/hooks/useLiveVoiceCall.ts');
  const quickChat = read('packages/dashboard/src/components/QuickChat.tsx');

  // ── Pure helper: run it, don't just read it ──────────────────────────────
  const mod = (await import(
    path.join(root, 'packages/api-server/src/live-voice.ts')
  )) as typeof import('../packages/api-server/src/live-voice.js');
  const { reconnectDelayMs, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_MAX_ATTEMPTS } = mod;
  const control = (await import(
    path.join(root, 'packages/api-server/src/live-voice-control.ts')
  )) as typeof import('../packages/api-server/src/live-voice-control.js');

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

  // ── Browser hang-up is authoritative, even while start() is still async ──
  check(
    'the browser hook uses a monotonic lifecycle token to cancel stale async starts',
    /const lifecycleRef = useRef\(0\);/.test(clientHook) &&
      /lifecycleRef\.current \+= 1;/.test(clientHook) &&
      /const lifecycle = lifecycleRef\.current \+ 1;/.test(clientHook),
  );
  check(
    'a hang-up during microphone permission cannot later resurrect the call',
    /const stream = await navigator\.mediaDevices\.getUserMedia[\s\S]{0,700}if \(lifecycle !== lifecycleRef\.current\) \{[\s\S]{0,220}stream\.getTracks\(\)\.forEach/.test(clientHook),
  );
  check(
    'a hang-up during websocket-ticket fetch cannot later create a replacement socket',
    /const \{ ticket \} = await api\.auth\.websocketTicket\(\);[\s\S]{0,500}if \(lifecycle !== lifecycleRef\.current\)/.test(clientHook) &&
      /const ws = new WebSocket[\s\S]{0,300}if \(lifecycle !== lifecycleRef\.current\) \{[\s\S]{0,160}ws\.close\(1000, 'cancelled before connect'\)/.test(clientHook),
  );
  check(
    'stale websocket callbacks cannot flip an ended call back to live or error',
    /ws\.onopen = \(\) => \{[\s\S]{0,180}if \(lifecycle !== lifecycleRef\.current\)/.test(clientHook) &&
      /ws\.onmessage = \(event\) => \{\s*if \(lifecycle !== lifecycleRef\.current\) return;/.test(clientHook) &&
      /ws\.onerror = \(\) => \{\s*if \(lifecycle !== lifecycleRef\.current\) return;/.test(clientHook),
  );
  check(
    'Hang up ends local audio immediately but gives the server a bounded persistence grace window',
    /HANGUP_SERVER_GRACE_MS\s*=\s*900/.test(clientHook) &&
      /ws\.send\(JSON\.stringify\(\{ type: 'end' \}\)\)/.test(clientHook) &&
      /operator hangup timeout/.test(clientHook) &&
      /setStatus\('ended'\);/.test(clientHook),
  );
  check(
    'QuickChat refreshes durable voice history twice so endedAt persistence wins over stale cache',
    /liveVoice\.status !== 'ended'/.test(quickChat) &&
      /invalidateQueries\(\{ queryKey: \['voice-chat-sessions'\] \}\)/.test(quickChat) &&
      /setTimeout\(\(\) => \{[\s\S]{0,160}voice-chat-sessions[\s\S]{0,80}\}, 1200\)/.test(quickChat),
  );
  check(
    'explicit spoken hang-up phrases are transport controls, not model interpretation',
    control.isExplicitLiveVoiceHangup('hang up') &&
      control.isExplicitLiveVoiceHangup('end the call') &&
      control.isExplicitLiveVoiceHangup('stop live talk') &&
      !control.isExplicitLiveVoiceHangup('goodbye') &&
      !control.isExplicitLiveVoiceHangup('bye dude') &&
      !control.isExplicitLiveVoiceHangup('I do') &&
      !control.isExplicitLiveVoiceHangup('stop that task') &&
      !control.isExplicitLiveVoiceHangup('the customer said goodbye yesterday'),
  );
  check(
    'Deepgram persists endedAt before acknowledging a recognized spoken hang-up',
    /isExplicitLiveVoiceHangup\(text\)[\s\S]{0,700}await db\.update\(voiceChatSessions\)[\s\S]{0,420}type: 'ended'[\s\S]{0,180}client\.close\(1000, 'spoken hangup'\)/.test(source),
  );
  check(
    'Gemini persists endedAt before acknowledging a recognized spoken hang-up',
    /isExplicitLiveVoiceHangup\(inputText\)[\s\S]{0,700}await endGeminiSessionRow\(\)[\s\S]{0,220}type: 'ended'[\s\S]{0,220}client\.close\(1000, 'spoken hangup'\)/.test(geminiSource),
  );
  check(
    'Gemini installs browser-close cleanup before initial provider setup can finish',
    /client\.on\('close', handleClientClose\);[\s\S]{0,160}const initialConnected = await connect\(\);/.test(geminiSource),
  );
  check(
    'server-authoritative ended events clean local state without sending a second hang-up',
    /case 'ended':[\s\S]{0,220}stop\(false\);/.test(clientHook),
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
  const activationStart = source.indexOf('activateDeepgramFallback =');
  const activationCredentialGuard = source.indexOf("if (!deepgramKey || !groqKey) {", activationStart);
  const activationMarkActive = source.indexOf('deepgramActive = true;', activationStart);
  check(
    'fallback credentials are validated before deepgramActive is set, so unavailable fallback cannot clean up an uninitialized socket',
    activationStart > -1 &&
      activationCredentialGuard > activationStart &&
      activationMarkActive > activationCredentialGuard,
  );

  // ── The think step falls back instead of dropping the call ───────────────
  // 2026-10-04: every turn hit Groq's 8,000 tokens/minute limit on
  // openai/gpt-oss-120b, which the workforce saturates on the same Groq
  // organization, and each FAILED_TO_THINK closed the session.
  const tools = [{ name: 'create_goal', description: 'guard', parameters: { type: 'object', properties: {} } }];
  const chain = mod.buildLiveVoiceThink('guard-key', 'guard prompt', tools) as Array<{
    provider: { type: string; model: string };
    endpoint?: { url: string; headers: Record<string, string> };
    prompt?: string;
    functions?: unknown[];
  }>;
  const llmClient = read('packages/core/src/llm-client.ts');
  const workforceGroqModel = /name: 'groq-gpt-oss-120b-byok',\s*model: '([^']+)'/.exec(llmClient)?.[1];
  check(
    'think is an ordered chain: Groq gpt-oss-20b, Groq gpt-oss-120b, then Deepgram-managed gpt-4o-mini',
    chain.map((entry) => `${entry.provider.type}:${entry.provider.model}`).join(' > ') ===
      'groq:openai/gpt-oss-20b > groq:openai/gpt-oss-120b > open_ai:gpt-4o-mini',
    chain.map((entry) => entry.provider),
  );
  check(
    "the first think model is not the one the workforce saturates on the same Groq organization",
    Boolean(workforceGroqModel) && chain[0].provider.model !== workforceGroqModel,
    { first: chain[0].provider.model, workforce: workforceGroqModel },
  );
  check(
    'every entry carries the full prompt and tools, so a fallback never answers without instructions',
    chain.every((entry) => entry.prompt === 'guard prompt' && entry.functions === tools),
  );
  check(
    'Groq entries send the key to the Groq endpoint; the managed entry has no endpoint and no key',
    chain.slice(0, 2).every((entry) => entry.endpoint?.headers.Authorization === 'Bearer guard-key' && /api\.groq\.com/.test(entry.endpoint.url)) &&
      chain[2].endpoint === undefined,
  );
  check(
    'the Settings message uses the chain rather than a single provider',
    /think: buildLiveVoiceThink\(groqKey, thinkPrompt, CHAT_TOOLS\)/.test(source) && !/think: \{\s*provider:/.test(source),
  );

  // ── A reconnect remembers the conversation ───────────────────────────────
  const turns = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `turn ${i}` }));
  const history = mod.liveVoiceHistoryContext([...turns, { role: 'user', content: '   ' }]);
  check(
    'history keeps the most recent turns, oldest first, in Deepgram History format, skipping blanks',
    history.length === mod.LIVE_VOICE_HISTORY_MAX_MESSAGES &&
      history[0].content === 'turn 8' &&
      history[history.length - 1].content === 'turn 19' &&
      history.every((message) => message.type === 'History'),
    history.slice(0, 2),
  );
  const long = mod.liveVoiceHistoryContext([
    { role: 'user', content: 'x'.repeat(2_000) },
    { role: 'assistant', content: 'y'.repeat(1_500) },
    { role: 'user', content: 'latest' },
  ]);
  check(
    'history stays under the character cap by dropping the oldest turns',
    long.length === 2 && long[1].content === 'latest' && long[0].content.startsWith('y'),
    long.map((message) => message.content.length),
  );
  check(
    'the Settings message restores history only when there is some',
    /\.\.\.\(history\.length > 0 \? \{ context: \{ messages: history \} \} : \{\}\)/.test(source) &&
      /conversationTurns\.push\(\{ role, content: text \}\)/.test(source),
  );
  check(
    'Deepgram warnings and errors are logged on one line',
    /console\.warn\('\[live-voice\] Deepgram warning:', JSON\.stringify\(event\)\)/.test(source) &&
      /console\.error\('\[live-voice\] Deepgram error:', JSON\.stringify\(event\)\)/.test(source),
  );

  if (failures > 0) {
    console.error(`\n${failures} live-voice-reconnect check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll live-voice-reconnect checks passed.');
}

main();
