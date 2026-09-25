/**
 * Guards the current APEX voice architecture:
 *
 * 1. Browser/admin Live Talk prefers a direct persistent Gemini 3.8 Live
 *    WebSocket session with full-duplex barge-in, async NON_BLOCKING tools,
 *    session resumption, audio transcription, context compression, and
 *    durable transcript persistence.
 * 2. live-voice.ts retains the proven Deepgram/Groq/ElevenLabs stack only as
 *    an availability fallback when Gemini cannot reach setupComplete.
 * 3. Telnyx/Deepgram and Vapi telephone paths keep their explicitly pinned
 *    ElevenLabs voice configuration.
 *
 * Structural source checks are used because CI does not carry production
 * provider credentials. Production verification is completed after deploy
 * from provider-selection and websocket logs.
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

  // ── Browser/admin Live Talk: Gemini primary, Deepgram fallback ─────────────
  const liveVoiceSource = fs.readFileSync(path.join(root, 'packages/api-server/src/live-voice.ts'), 'utf8');
  const geminiLiveSource = fs.readFileSync(path.join(root, 'packages/api-server/src/gemini-live-session.ts'), 'utf8');

  check(
    'live-voice.ts attempts the direct Gemini session before the Deepgram fallback',
    /tryStartGeminiLiveSession/.test(liveVoiceSource) &&
      liveVoiceSource.indexOf('tryStartGeminiLiveSession') < liveVoiceSource.indexOf('connectToDeepgram();'),
  );
  check(
    'live-voice.ts defaults the browser/admin provider to Gemini but permits an explicit Deepgram fallback override',
    /APEX_LIVE_VOICE_PROVIDER/.test(liveVoiceSource) &&
      /\|\| 'gemini'/.test(liveVoiceSource) &&
      /requestedProvider !== 'deepgram'/.test(liveVoiceSource),
  );
  checkSpeakBlock('live-voice.ts Deepgram fallback', liveVoiceSource);

  check(
    'Gemini adapter pins the fast realtime model to gemini-3.8-live (not Extended Thinking in the critical path)',
    /GEMINI_LIVE_MODEL\s*=\s*'gemini-3\.8-live'/.test(geminiLiveSource) &&
      !/gemini-3\.8-live-extended-thinking/.test(geminiLiveSource),
  );
  check(
    'Gemini adapter uses the raw BidiGenerateContent WebSocket endpoint',
    /generativelanguage\.googleapis\.com\/ws\/google\.ai\.generativelanguage\.v1beta\.GenerativeService\.BidiGenerateContent/.test(geminiLiveSource),
  );
  check(
    'Gemini setup requests AUDIO output through generationConfig',
    /generationConfig:\s*\{\s*responseModalities:\s*\['AUDIO'\]\s*\}/.test(geminiLiveSource),
  );
  check(
    'all Live Talk function declarations are explicitly NON_BLOCKING',
    /behavior:\s*'NON_BLOCKING'/.test(geminiLiveSource),
  );
  check(
    'server-side activity detection uses start-of-activity interruption for native barge-in',
    /activityHandling:\s*'START_OF_ACTIVITY_INTERRUPTS'/.test(geminiLiveSource) &&
      /START_SENSITIVITY_HIGH/.test(geminiLiveSource),
  );
  check(
    'input and output audio transcription are enabled for live captions and latency telemetry',
    /inputAudioTranscription:\s*\{\}/.test(geminiLiveSource) &&
      /outputAudioTranscription:\s*\{\}/.test(geminiLiveSource),
  );
  check(
    'session resumption is enabled and the newest resumable handle is retained',
    /sessionResumption:/.test(geminiLiveSource) &&
      /sessionResumptionUpdate/.test(geminiLiveSource) &&
      /newHandle/.test(geminiLiveSource) &&
      /sessionHandle\s*=\s*update\.newHandle/.test(geminiLiveSource),
  );
  check(
    'context window compression is enabled for long-running operator conversations',
    /contextWindowCompression:\s*\{[\s\S]{0,120}slidingWindow:\s*\{\}/.test(geminiLiveSource),
  );
  check(
    'realtime PCM input is identified as 16 kHz audio',
    /mimeType:\s*'audio\/pcm;rate=16000'/.test(geminiLiveSource),
  );
  check(
    'Gemini interruption is relayed to the browser so queued playback is flushed',
    /serverContent\.interrupted/.test(geminiLiveSource) &&
      /type:\s*'interrupted'/.test(geminiLiveSource),
  );
  check(
    'Gemini tool execution is detached from the realtime message handler',
    /void \(async \(\) => \{/.test(geminiLiveSource) &&
      /executeTool/.test(geminiLiveSource) &&
      /'WHEN_IDLE'/.test(geminiLiveSource),
  );
  check(
    'Gemini live sessions and turns are durably persisted',
    /db\.insert\(voiceChatSessions\)/.test(geminiLiveSource) &&
      /db\.insert\(voiceChatTurns\)/.test(geminiLiveSource) &&
      /db\.update\(voiceChatSessions\)[\s\S]*?endedAt: new Date\(\)/.test(geminiLiveSource),
  );
  check(
    'provider setup failure returns false so the same browser call can fall back without redialing',
    /const initialConnected = await connect\(\)/.test(geminiLiveSource) &&
      /if \(!initialConnected\)/.test(geminiLiveSource) &&
      /return false;/.test(geminiLiveSource) &&
      /falling back to Deepgram/.test(liveVoiceSource),
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
