/**
 * Guard: the per-tool-call "Calling tool: X(...)" log line keeps enough of
 * the real arguments to diagnose an agent's own reasoning (e.g. an
 * escalation's reviewObjective) after the fact, instead of cutting it off
 * mid-sentence with no indication anything was cut.
 *
 * Direct execution of the pure truncation helper — no database or LLM calls.
 */
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

async function main(): Promise<void> {
  console.log('Verifying tool-call log truncation...\n');

  const mod = (await import(
    path.join(root, 'packages/core/src/base-agent.ts')
  )) as typeof import('../packages/core/src/base-agent.js');
  const { truncateToolCallArgsForLog } = mod;

  const shortArgs = JSON.stringify({ targetRole: 'CEO', note: 'looks fine' });
  check(
    'arguments well under the limit pass through unchanged, with no ellipsis',
    truncateToolCallArgsForLog(shortArgs) === shortArgs,
    truncateToolCallArgsForLog(shortArgs),
  );

  // The exact shape that motivated this: a real reviewObjective sentence
  // that the old 100-char limit cut off mid-word with no indication. Long
  // enough to have broken under the old limit (100), short enough to still
  // fit whole under the new one (300) — this is the case the fix targets.
  const reviewObjective = JSON.stringify({
    targetRole: 'CEO',
    reviewObjective:
      'ESCALATION — blocked on an environment credential, not on insufficient effort from the delegated agents.',
  });
  check(
    'a real sentence-length argument that broke the old 100-char limit is NOT cut short anymore',
    reviewObjective.length > 100 &&
      truncateToolCallArgsForLog(reviewObjective) === reviewObjective,
    { length: reviewObjective.length, result: truncateToolCallArgsForLog(reviewObjective) },
  );

  const longArgs = 'x'.repeat(500);
  const truncated = truncateToolCallArgsForLog(longArgs);
  check(
    'arguments over the limit are actually cut, not left to grow the log line unbounded',
    truncated.length < longArgs.length,
    truncated.length,
  );
  check(
    'a truncated line is marked with an ellipsis so it never silently looks complete',
    truncated.endsWith('…'),
    truncated,
  );
  check(
    'the cut point is exactly the configured limit, not an off-by-one',
    truncated === `${longArgs.slice(0, 300)}…`,
  );

  check(
    'a custom limit is honored (callers are not hardcoded to 300)',
    truncateToolCallArgsForLog(longArgs, 10) === `${'x'.repeat(10)}…`,
    truncateToolCallArgsForLog(longArgs, 10),
  );

  if (failures > 0) {
    console.error(`\n${failures} tool-call-log-truncation check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll tool-call-log-truncation checks passed.');
}

main();
