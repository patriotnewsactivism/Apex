/**
 * Guards the two mobile regressions reported against the Quick Chat screen:
 *
 *  1. "APEX Command runs way off screen on mobile" — <main> is a flex child
 *     with the default min-width:auto, so a wide chat message widened it past
 *     the viewport; the mobile `overflow-x: hidden` on html/body then simply
 *     clipped the content instead of wrapping it.
 *  2. "voice chat wont work" — the capture AudioContext was constructed inside
 *     ws.onopen, which is not a user gesture, so iOS Safari left it suspended
 *     and no audio was ever captured or played. Playback additionally forced a
 *     24kHz context (rejected on iOS) and there was no webkitAudioContext
 *     fallback and no resume() anywhere.
 *
 * These are browser-layout/gesture behaviours with no jsdom-observable
 * equivalent (jsdom implements neither flex layout nor Web Audio), so this
 * guard asserts on the source that the fixes are present and cannot silently
 * regress.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ ${label}`);
  }
}

const app = read('packages/dashboard/src/App.tsx');
const quickChat = read('packages/dashboard/src/components/QuickChat.tsx');
const voice = read('packages/dashboard/src/hooks/useLiveVoiceCall.ts');

console.log('── Mobile layout (no horizontal overflow) ──');

// <main> is the flex child that must be allowed to shrink.
const mainStyle = app.slice(app.indexOf('<main'), app.indexOf('<main') + 400);
check('<main> can shrink below its content width', /minWidth:\s*0/.test(mainStyle));
check('<main> is capped at the viewport width', /maxWidth:\s*'100%'/.test(mainStyle));

check(
  'the chat column can shrink inside the grid',
  /flexDirection:\s*'column',\s*gap:\s*12,\s*minWidth:\s*0/.test(quickChat),
);
check(
  'chat bubbles break unbroken strings instead of widening the page',
  /overflowWrap:\s*'anywhere'/.test(quickChat) && /wordBreak:\s*'break-word'/.test(quickChat),
);
check('the live voice bar wraps rather than overflowing', /flexWrap:\s*'wrap'/.test(quickChat));
check(
  'the composer textarea can shrink next to its buttons',
  /flex:\s*1,\s*\n\s*minWidth:\s*0,\s*\n\s*resize:\s*'none'/.test(quickChat),
);

console.log('── Live voice on mobile browsers ──');

check(
  'a webkitAudioContext fallback exists for iOS Safari',
  /webkitAudioContext/.test(voice) && /function getAudioContextCtor/.test(voice),
);
check('suspended contexts are resumed', /function resumeContext/.test(voice) && /\.resume\(\)/.test(voice));

// Both contexts must be constructed before the first await inside start().
const startBody = voice.slice(voice.indexOf('const start = useCallback'));
const firstAwait = startBody.indexOf('await ');
const beforeFirstAwait = startBody.slice(0, firstAwait);
check(
  'the capture context is created inside the user gesture (before any await)',
  /captureCtxRef\.current = captureCtx/.test(beforeFirstAwait),
);
check(
  'the playback context is created inside the user gesture (before any await)',
  /playbackCtxRef\.current = playbackCtx/.test(beforeFirstAwait),
);
check(
  'both contexts are resumed inside the user gesture',
  (beforeFirstAwait.match(/resumeContext\(/g) ?? []).length >= 2,
);
check(
  'the capture context is no longer constructed in ws.onopen',
  !/ws\.onopen[\s\S]{0,400}new AudioCtx\(/.test(voice),
);
check(
  'playback no longer forces a 24kHz context (iOS rejects it)',
  !/new AudioCtx\(\{\s*sampleRate/.test(voice) && !/new AudioContext\(\{\s*sampleRate/.test(voice),
);
check(
  'buffers are still authored at the wire output rate so the browser resamples',
  /createBuffer\(1,\s*float\.length,\s*OUTPUT_RATE\)/.test(voice),
);
check(
  'an unavailable microphone API reports a clear cause instead of failing silently',
  /navigator\.mediaDevices\?\.getUserMedia/.test(voice) && /secure \(https\) connection/.test(voice),
);
check(
  'a failed start tears the audio contexts back down',
  /captureCtx\.close\(\)[\s\S]{0,200}playbackCtx\.close\(\)/.test(voice),
);

assert.ok(true);
console.log(failures === 0 ? '✅ ALL MOBILE CHAT SURFACE GUARDS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
