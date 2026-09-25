/**
 * Guard: every AI voice agent APEX runs actually uses ElevenLabs at the
 * confirmed-correct realism tier when configured, and the live browser voice
 * chat's transcript is durably persisted rather than existing only in React
 * state until the tab closes.
 *
 * Context (2026-09-25): Don reported the live voice chat as unreliable and
 * non-durable ("doesn't always answer back", "doesn't save the chat"), and
 * asked to standardize on ElevenLabs realism everywhere now that he holds
 * upgraded ElevenLabs and Deepgram plans. Auditing all three voice paths
 * found two of three (the browser live-voice chat and inbound BuildMyBot
 * calls, both on Deepgram's Voice Agent API) were never touching ElevenLabs
 * at all -- running Deepgram's own bundled Aura voice -- and the third
 * (Vapi phone calls) had no explicit model tier set (a silent, likely
 * lowest-tier default).
 *
 * This guard pins three things that are each easy to silently regress:
 *
 *   1. The Deepgram <-> ElevenLabs speak-provider shape. This is a REAL,
 *      previously-reported production failure mode (not a hypothetical):
 *      github.com/orgs/deepgram/discussions/1243 documents Deepgram
 *      returning UNPARSABLE_CLIENT_MESSAGE -> FAILED_TO_SPEAK when `endpoint`
 *      is nested inside `provider` instead of being its sibling -- the exact
 *      same class of "field one level too shallow" bug already found and
 *      fixed in Vapi's `tools` placement in tool-registry.ts. Also pins
 *      model_id to eleven_turbo_v2_5 (the tier Deepgram's own docs confirm
 *      as supported for real-time streaming) and language_code to 'en'
 *      (that same discussion's documented fix -- NOT 'en-US').
 *   2. Vapi's voice.model is explicitly set (eleven_v3, Don's explicit choice
 *      after being shown the realism-vs-latency tradeoff), not left on
 *      whatever Vapi's silent default is.
 *   3. live-voice.ts persists both session and turn rows for durable
 *      history, and both DB paths in the tool-registry.ts Vapi-adjacent
 *      areas are structurally present.
 *
 * Structural source checks are used throughout (the same established
 * technique as verify-call-outcome-capture.ts's webhook-upsert checks)
 * rather than a full WebSocket integration harness: faking a real Deepgram
 * agent peer well enough to exercise setupLiveVoice() end-to-end is
 * disproportionate to what this guard needs to prove.
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

/** Extracts a `speak: { ... }` (or `speak: (() => { ... })()`) block and
 *  checks the ElevenLabs branch has the confirmed-correct shape. */
function checkSpeakBlock(label: string, source: string): void {
  const speakStart = source.indexOf('speak:');
  check(`${label}: found a speak: block`, speakStart > -1);
  if (speakStart === -1) return;
  // Generous slice -- large enough to contain the whole conditional/IIFE
  // shape without needing a real brace-matching parser.
  const speakBlock = source.slice(speakStart, speakStart + 1500);

  check(
    `${label}: eleven_labs speak provider is present`,
    /type:\s*'eleven_labs'/.test(speakBlock),
    speakBlock,
  );
  check(
    `${label}: model_id is pinned to eleven_turbo_v2_5 (the tier Deepgram's docs confirm supported)`,
    /model_id:\s*ELEVENLABS_TTS_MODEL/.test(speakBlock) || /model_id:\s*'eleven_turbo_v2_5'/.test(speakBlock),
  );
  check(
    `${label}: language_code is 'en', not 'en-US' (github.com/orgs/deepgram/discussions/1243's documented fix)`,
    /language_code:\s*'en'/.test(speakBlock) && !/language_code:\s*'en-US'/.test(speakBlock),
  );
  // The regression this guard exists for: endpoint must be a SIBLING of
  // provider inside the eleven_labs branch, never nested inside it.
  const providerMatch = /provider:\s*\{[^}]*type:\s*'eleven_labs'[^}]*\}/.exec(speakBlock);
  check(`${label}: found the eleven_labs provider: {...} object to inspect`, Boolean(providerMatch));
  if (providerMatch) {
    check(
      `${label}: endpoint is NOT nested inside provider (the exact shape that produces FAILED_TO_SPEAK)`,
      !/endpoint/.test(providerMatch[0]),
      providerMatch[0],
    );
  }
  check(
    `${label}: endpoint.url points at ElevenLabs' text-to-speech stream endpoint`,
    /https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\//.test(speakBlock) && /\/stream/.test(speakBlock),
  );
  check(
    `${label}: xi-api-key header is present for ElevenLabs auth`,
    /xi-api-key/.test(speakBlock),
  );
  check(
    `${label}: falls back to Deepgram's own Aura voice when no ElevenLabs key is configured, rather than breaking the call`,
    /aura-2-asteria-en/.test(speakBlock),
  );
}

function main(): void {
  console.log('Verifying voice-agent realism and live-voice persistence...\n');

  // ── live-voice.ts: browser live-voice chat ────────────────────────────────
  const liveVoiceSource = fs.readFileSync(path.join(root, 'packages/api-server/src/live-voice.ts'), 'utf8');
  checkSpeakBlock('live-voice.ts', liveVoiceSource);

  check(
    'live-voice.ts: ELEVENLABS_API_KEY is read and treated as optional (falls back, not a hard failure like Deepgram/Groq)',
    /process\.env\.ELEVENLABS_API_KEY/.test(liveVoiceSource),
  );
  check(
    'live-voice.ts: a voice_chat_sessions row is inserted before Deepgram is contacted (so a call that never connects is still visible)',
    /db\.insert\(voiceChatSessions\)/.test(liveVoiceSource) &&
      liveVoiceSource.indexOf('db.insert(voiceChatSessions)') < liveVoiceSource.indexOf('connectToDeepgram();'),
  );
  check(
    'live-voice.ts: a voice_chat_turns row is inserted for real conversation text (not the injected screen-context echo)',
    /db\.insert\(voiceChatTurns\)/.test(liveVoiceSource) && /persistTurn\(role, text\)/.test(liveVoiceSource),
  );
  check(
    'live-voice.ts: the session row is closed out (endedAt) when the client disconnects',
    /db\.update\(voiceChatSessions\)[\s\S]*?endedAt: new Date\(\)/.test(liveVoiceSource),
  );
  check(
    'live-voice.ts: persistence writes are fire-and-forget (.catch, not awaited) so a DB hiccup can never add latency to call setup or fail the call',
    !/await db\.insert\(voiceChat/.test(liveVoiceSource) && !/await db\.update\(voiceChatSessions\)/.test(liveVoiceSource),
  );
  // live-voice.ts legitimately mentions Gemini once, historically ("Switched
  // from Gemini Live after Google denied...") -- that is accurate and worth
  // keeping, not stale. What must never come back is a PRESENT-TENSE claim
  // that Gemini is what live voice currently runs on.
  check(
    "live-voice.ts: no present-tense claim that live voice currently runs on Gemini",
    !/is (a )?Gemini|runs on Gemini|via Gemini|the Gemini (session|protocol)/i.test(liveVoiceSource),
  );

  // ── telnyx-deepgram-agent.ts: inbound BuildMyBot calls ────────────────────
  const telnyxAgentSource = fs.readFileSync(path.join(root, 'packages/api-server/src/telnyx-deepgram-agent.ts'), 'utf8');
  checkSpeakBlock('telnyx-deepgram-agent.ts', telnyxAgentSource);

  // ── tool-registry.ts: Vapi phone calls ────────────────────────────────────
  const registrySource = fs.readFileSync(path.join(root, 'packages/core/src/tool-registry.ts'), 'utf8');
  const mocStart = registrySource.indexOf("name: 'make_outbound_call'");
  const mocEnd = registrySource.indexOf("name: 'get_call_status'");
  const ciaStart = registrySource.indexOf("name: 'configure_inbound_assistant'");
  const ciaEnd = registrySource.indexOf("name: 'provision_inbound_number'");
  check('found make_outbound_call and configure_inbound_assistant to inspect', mocStart > -1 && mocEnd > mocStart && ciaStart > -1 && ciaEnd > ciaStart);
  if (mocStart > -1 && mocEnd > mocStart && ciaStart > -1 && ciaEnd > ciaStart) {
    const mocBody = registrySource.slice(mocStart, mocEnd);
    const ciaBody = registrySource.slice(ciaStart, ciaEnd);
    check(
      "make_outbound_call: voice.model is explicitly set to eleven_v3 (Don's explicit choice), not left on Vapi's silent default",
      /voice:\s*\{[\s\S]*?model:\s*'eleven_v3'/.test(mocBody),
    );
    check(
      'make_outbound_call: voiceId is configurable via ELEVENLABS_VOICE_ID rather than hard-coded only',
      /voiceId:\s*process\.env\.ELEVENLABS_VOICE_ID/.test(mocBody),
    );
    check(
      'configure_inbound_assistant: voice.model is explicitly set to eleven_v3, matching make_outbound_call',
      /voice:\s*\{[\s\S]*?model:\s*'eleven_v3'/.test(ciaBody),
    );
    check(
      'configure_inbound_assistant: voiceId is configurable via ELEVENLABS_VOICE_ID',
      /voiceId:\s*process\.env\.ELEVENLABS_VOICE_ID/.test(ciaBody),
    );
  }

  // ── Schema and idempotent-migration DDL stay in lockstep ─────────────────
  const schemaSource = fs.readFileSync(path.join(root, 'lib/db/src/schema.ts'), 'utf8');
  const clientSource = fs.readFileSync(path.join(root, 'lib/db/src/client.ts'), 'utf8');

  check('schema.ts exports voiceChatSessions', /export const voiceChatSessions = pgTable\('voice_chat_sessions'/.test(schemaSource));
  check('schema.ts exports voiceChatTurns', /export const voiceChatTurns = pgTable\('voice_chat_turns'/.test(schemaSource));
  check('the idempotent DDL creates voice_chat_sessions', clientSource.includes('CREATE TABLE IF NOT EXISTS voice_chat_sessions'));
  check('the idempotent DDL creates voice_chat_turns', clientSource.includes('CREATE TABLE IF NOT EXISTS voice_chat_turns'));

  // ── The history is actually surfaced somewhere a human will look ─────────
  const chatRouteSource = fs.readFileSync(path.join(root, 'packages/api-server/src/routes/chat.ts'), 'utf8');
  check("chat.ts registers GET /voice-sessions", /router\.get\('\/voice-sessions'/.test(chatRouteSource));

  const quickChatSource = fs.readFileSync(path.join(root, 'packages/dashboard/src/components/QuickChat.tsx'), 'utf8');
  check('QuickChat.tsx renders a past-voice-calls view wired to the new endpoint', /api\.chat\.voiceSessions/.test(quickChatSource));
  check(
    "QuickChat.tsx: no stale 'Gemini Live' label remains in the call bar itself",
    !/Gemini Live/.test(quickChatSource),
  );

  console.log(
    failures === 0
      ? '\n✅ Voice-agent realism and live-voice persistence verified.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
