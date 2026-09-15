/**
 * Guard: a failing embedding pipeline must say WHY, and must not stay failed
 * forever on one bad attempt.
 *
 * Semantic memory recall was broken in production from 2026-08-28 to
 * 2026-09-15 and nobody noticed, because memory.ts catches the failure and
 * falls back to keyword search. Agents kept working with worse recall and
 * nothing went red. The first cause was a musl/glibc mismatch in the runtime
 * image, fixed by matching the base images.
 *
 * Fixing it exposed the second problem. The very next deploy logged:
 *
 *   [LLM] Local embedding pipeline unavailable:
 *
 * Nothing after the colon. `err.message` was the empty string, and the handler
 * interpolated it directly, so the replacement failure was undiagnosable from
 * the logs it produced. An error reporter that can render as no error at all
 * is the bug this guard exists to prevent.
 *
 * The second half is the latch: `pipelineError` was sticky for the lifetime of
 * the process, so a single transient failure on first load -- and first load
 * fetches a model over the network -- served keyword search until restart,
 * replaying one cached string on every lookup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describePipelineFailure } from '../packages/core/src/llm-client.js';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

console.log('Verifying embedding-pipeline diagnostics...\n');

// ── The exact production symptom, by execution ──────────────────────────────
const empty = describePipelineFailure(new Error(''));
check(
  'an Error with an empty message still produces a diagnosis',
  empty.length > 0 && /empty Error/.test(empty),
  empty,
);

const coded = describePipelineFailure(
  Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }),
);
check(
  'an error code is surfaced beside the message',
  /fetch failed/.test(coded) && /ENOTFOUND/.test(coded),
  coded,
);

const chained = describePipelineFailure(
  new Error('outer', { cause: new Error('inner DNS failure') }),
);
check(
  'the cause chain is followed, not discarded',
  /outer/.test(chained) && /inner DNS failure/.test(chained),
  chained,
);

// The realistic network-failure shape: a wrapper with no message of its own
// around the error that actually carries the cause.
const emptyOuter = describePipelineFailure(
  new Error('', { cause: Object.assign(new Error(''), { code: 'EAI_AGAIN' }) }),
);
check(
  'an empty outer error still reports a coded cause',
  /EAI_AGAIN/.test(emptyOuter),
  emptyOuter,
);

check('a non-Error throw is stringified', describePipelineFailure('boom') === 'boom');

// A self-referential cause must terminate rather than hang CI.
const cyclic: Error & { cause?: unknown } = new Error('loop');
cyclic.cause = cyclic;
check('a cyclic cause chain terminates', describePipelineFailure(cyclic) === 'loop');

// ── The latch must expire ───────────────────────────────────────────────────
const client = fs.readFileSync(
  path.join(root, 'packages/core/src/llm-client.ts'),
  'utf8',
);
check(
  'a latched failure is bounded by attempts and a cooldown, not permanent',
  /pipelineAttempts >= PIPELINE_MAX_ATTEMPTS \|\| Date\.now\(\) < pipelineRetryAt/.test(client),
);
check(
  'a successful load clears the previous error',
  /pipelineError = null;/.test(client),
);

// ── It has to be visible without reading logs ───────────────────────────────
const health = fs.readFileSync(
  path.join(root, 'packages/api-server/src/index.ts'),
  'utf8',
);
check(
  'embedding state is served on /health, not only logged',
  /embeddings: getEmbeddingPipelineState\(\)/.test(health),
);

console.log(
  failures === 0
    ? '\n✅ All embedding-diagnostic checks passed.'
    : `\n❌ ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
