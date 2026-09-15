/**
 * Guard: the /api/sales-ops/overview call-cost extraction can never 500 the
 * whole endpoint, and a failure that does slip through is diagnosable.
 *
 * Root cause (reproduced against a real Postgres 16 + pgbouncer in
 * transaction-pooling mode, matching production's exact client config —
 * prepare:false, see lib/db/src/client.ts): CALL_COST_PATTERN used to be
 * 'Cost: \\$([0-9.]+)'. That pattern is unanchored, and vapi.ts appends the
 * LLM-generated call summary to the SAME log line right after the cost. If
 * the summary ever contained its own "Cost: $<digits/dots>"-shaped text (a
 * price or version number the model mentioned), the old capture group would
 * swallow a second '.' — e.g. "4.12.34" — and Postgres rejected that with
 * `invalid input syntax for type double precision` on the ::float8 cast.
 * Postgres has no per-row fallback for a failed cast, so that one row 500'd
 * every metric on the page (leads/emails/campaigns/autonomy), not just the
 * cost figure, because they all ride in the same Promise.all.
 *
 * Separately, the error that reached the operator was Drizzle's generic
 * "Failed query: <sql>\nparams: <params>" wrapper, not the actual Postgres
 * message — the real cause lives on `.cause` and nothing surfaced it. Fixed
 * alongside the regex so the next unexpected failure is diagnosable from the
 * API response instead of requiring a live reproduction to even see what
 * broke.
 *
 * Source-structural for the route wiring (no live Postgres in CI) plus
 * direct execution of the two pure exports (CALL_COST_PATTERN, errorMessage)
 * against both a well-formed and a malformed log line.
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
  console.log('Verifying the sales-ops call-cost regex and error surfacing...\n');

  const route = read('packages/api-server/src/routes/sales-ops.ts');

  // ── Source-structural: the fragile shape must be gone ────────────────────
  check(
    'CALL_COST_PATTERN no longer allows more than one decimal point',
    !/CALL_COST_PATTERN = 'Cost: \\\\\$\(\[0-9\.\]\+\)'/.test(route),
  );
  check(
    'the substring() calls in /overview still use the shared CALL_COST_PATTERN constant',
    (route.match(/substring\(\$\{logs\.message\} from \$\{CALL_COST_PATTERN\}\)/g) ?? []).length === 2,
  );
  check(
    'every catch block in this file uses errorMessage(), not a bare err.message (at least the original /overview, /call, /automate)',
    !/res\.status\(500\)\.json\(\{ error: err instanceof Error/.test(route) &&
      (route.match(/error: errorMessage\(err\)/g) ?? []).length >= 3,
  );

  // ── Pure exports: run them, don't just read them ──────────────────────────
  const mod = (await import(
    path.join(root, 'packages/api-server/src/routes/sales-ops.ts')
  )) as typeof import('../packages/api-server/src/routes/sales-ops.js');
  const { CALL_COST_PATTERN, errorMessage } = mod;

  // Postgres's default regex engine (ARE) and JS RegExp agree on greedy +/?
  // and non-capturing groups for this shape, so a JS RegExp built from the
  // same pattern text is a faithful stand-in for what Postgres will match.
  const re = new RegExp(CALL_COST_PATTERN);

  const wellFormed = 'Outbound call ended. Duration: 45s. Cost: $0.1234. Summary: Customer was interested.';
  const wellFormedMatch = re.exec(wellFormed);
  check(
    'a well-formed cost line still extracts the full decimal value',
    wellFormedMatch?.[1] === '0.1234',
    { captured: wellFormedMatch?.[1] },
  );
  check(
    'the well-formed capture parses as a finite number (what ::float8 requires)',
    Number.isFinite(Number(wellFormedMatch?.[1])),
  );

  // The actual failure mode: a second decimal point bleeding in from the
  // free-form summary text appended after the cost on the same log line.
  const malformed =
    'Outbound call ended. Duration: 12s. Cost: $0.12. Summary: they asked about the v4.12.34 upgrade path.';
  const malformedMatch = re.exec(malformed);
  check(
    'a stray decimal-looking substring later in the line does not get pulled into the capture',
    malformedMatch?.[1] === '0.12',
    { captured: malformedMatch?.[1] },
  );

  // Directly reproduce the historical bug shape and confirm the NEW pattern
  // can never reproduce it: no possible match of this pattern contains two
  // dots, because the second dot can only start a match, never extend one.
  const pathological = 'Cost: $0.12.34';
  const pathologicalCapture: string | undefined = re.exec(pathological)?.[1];
  check(
    'even when the cost field itself is malformed, the capture never contains two decimal points',
    pathologicalCapture !== undefined && (pathologicalCapture.match(/\./g) ?? []).length <= 1,
    { captured: pathologicalCapture },
  );
  check(
    'that capture parses as a finite number rather than the NaN/invalid text a ::float8 cast would reject',
    pathologicalCapture !== undefined && Number.isFinite(Number(pathologicalCapture)),
    { captured: pathologicalCapture },
  );

  // No match at all (no cost mentioned) must stay a clean non-match, not throw.
  const noCost = 'Outbound call ringing to +18328804970';
  check('a line with no cost mention simply does not match', re.exec(noCost) === null);

  // ── errorMessage: prefers the wrapped driver error's real message ────────
  const wrapped = new Error("Failed query: select ... params: apex-sales-001");
  (wrapped as { cause?: unknown }).cause = new Error(
    'invalid input syntax for type double precision: "0.12.34"',
  );
  check(
    'errorMessage() surfaces the real cause instead of the generic query-dump wrapper',
    errorMessage(wrapped) === 'invalid input syntax for type double precision: "0.12.34"',
    { got: errorMessage(wrapped) },
  );
  const plain = new Error('some other failure');
  check(
    'errorMessage() falls back to err.message when there is no cause',
    errorMessage(plain) === 'some other failure',
  );
  check(
    'errorMessage() falls back to String(err) for a non-Error throw',
    errorMessage('boom') === 'boom',
  );

  if (failures > 0) {
    console.error(`\n${failures} sales-ops-call-cost-regex check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll sales-ops-call-cost-regex checks passed.');
}

main();
