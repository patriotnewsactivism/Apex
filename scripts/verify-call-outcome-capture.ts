/**
 * Guard: outbound call outcomes are captured as structured, queryable data —
 * not left as prose in a `logs` line a human has to re-read to act on.
 *
 * Before this, `make_outbound_call`'s only record of what happened was one
 * free-text `logs` row per call (message + truncated transcript). A prospect
 * agreeing to "Tuesday at ten" existed only as words inside that sentence:
 * nothing queryable, no appointment a dashboard could list, no disposition to
 * filter by. This guard pins the three places that changed:
 *
 *   1. zonedTimeToUtc — the AI reports a date/time/US-region triple, not a UTC
 *      offset, so resolving it correctly requires real IANA timezone data
 *      (DST included) with no timezone library in this repo's dependencies.
 *      Wrong here means a booked meeting silently lands at the wrong hour.
 *
 *   2. fallbackDispositionFromEndedReason — voicemail, no-answer, and a
 *      hang-up before the AI could report an outcome must never be recorded
 *      as if nothing happened; they still get a row, conservatively.
 *
 *   3. The transient Vapi assistant config make_outbound_call actually
 *      builds: it must carry the record_meeting_outcome function (with
 *      disposition required and the four-region timezone enum) AND a
 *      server-injected "today's date" line in the system prompt — the AI has
 *      no other way to resolve "next Tuesday" into a real calendar date.
 *      Exercised through the tool's real execute() with a stubbed fetch (the
 *      established pattern in verify-lead-source-tools.ts), not by reading
 *      source for the string "record_meeting_outcome".
 *
 * DST correctness is checked against the US rule in effect since 2007
 * (2nd Sunday of March to 1st Sunday of November) using dates on both sides
 * of a 2026 transition for all four regions — the one part of this that is
 * genuinely easy to get subtly wrong and hard to notice by inspection.
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

async function main(): Promise<void> {
  console.log('Verifying outbound call outcomes are captured as structured data...\n');

  const vapiMod = (await import(
    path.join(root, 'packages/api-server/src/routes/vapi.ts')
  )) as typeof import('../packages/api-server/src/routes/vapi.js');
  const { zonedTimeToUtc, fallbackDispositionFromEndedReason } = vapiMod;

  // ── zonedTimeToUtc: DST-correct resolution, no timezone library ─────────
  //
  // 2026 US DST: begins 2026-03-08 02:00 local, ends 2026-11-01 02:00 local.
  // One winter date and one summer date per region, so a hard-coded
  // standard-time-only offset table would fail half of these.
  const cases: Array<[string, string, string, string, string]> = [
    // [label, date, time, region, expectedUtcIso]
    ['Eastern, standard time (EST = UTC-5)', '2026-01-15', '10:00', 'Eastern', '2026-01-15T15:00:00.000Z'],
    ['Eastern, daylight time (EDT = UTC-4)', '2026-07-15', '10:00', 'Eastern', '2026-07-15T14:00:00.000Z'],
    ['Central, standard time (CST = UTC-6)', '2026-01-15', '10:00', 'Central', '2026-01-15T16:00:00.000Z'],
    ['Central, daylight time (CDT = UTC-5)', '2026-07-15', '10:00', 'Central', '2026-07-15T15:00:00.000Z'],
    ['Mountain, standard time (MST = UTC-7)', '2026-01-15', '10:00', 'Mountain', '2026-01-15T17:00:00.000Z'],
    ['Mountain, daylight time (MDT = UTC-6)', '2026-07-15', '10:00', 'Mountain', '2026-07-15T16:00:00.000Z'],
    ['Pacific, standard time (PST = UTC-8)', '2026-01-15', '10:00', 'Pacific', '2026-01-15T18:00:00.000Z'],
    ['Pacific, daylight time (PDT = UTC-7)', '2026-07-15', '10:00', 'Pacific', '2026-07-15T17:00:00.000Z'],
  ];
  for (const [label, date, time, region, expectedIso] of cases) {
    const result = zonedTimeToUtc(date, time, region);
    check(
      `zonedTimeToUtc: ${label}`,
      result !== null && result.toISOString() === expectedIso,
      { date, time, region, expectedIso, got: result?.toISOString() ?? null },
    );
  }

  // A date right at the spring-forward transition: 2026-03-08 is the day DST
  // begins. 1:30 AM Eastern that morning is still standard time (EST), since
  // the switch happens at 2:00 AM — proves the boundary itself resolves on
  // the correct side, not just dates safely away from it.
  const justBeforeSpringForward = zonedTimeToUtc('2026-03-08', '01:30', 'Eastern');
  check(
    'zonedTimeToUtc: 1:30 AM Eastern on the DST-start date is still EST (UTC-5)',
    justBeforeSpringForward !== null && justBeforeSpringForward.toISOString() === '2026-03-08T06:30:00.000Z',
    justBeforeSpringForward?.toISOString() ?? null,
  );

  // ── zonedTimeToUtc: fail closed on anything unparseable ──────────────────
  check('zonedTimeToUtc: missing date returns null', zonedTimeToUtc(undefined, '10:00', 'Eastern') === null);
  check('zonedTimeToUtc: missing time returns null', zonedTimeToUtc('2026-09-30', undefined, 'Eastern') === null);
  check('zonedTimeToUtc: missing region returns null', zonedTimeToUtc('2026-09-30', '10:00', undefined) === null);
  check(
    'zonedTimeToUtc: an unrecognized region name (not one of the four given to the AI) returns null rather than guessing',
    zonedTimeToUtc('2026-09-30', '10:00', 'Atlantic') === null,
  );
  check(
    'zonedTimeToUtc: malformed date ("next Tuesday" leaking through unresolved) returns null',
    zonedTimeToUtc('next Tuesday', '10:00', 'Eastern') === null,
  );
  check(
    'zonedTimeToUtc: malformed time ("morning" leaking through unresolved) returns null',
    zonedTimeToUtc('2026-09-30', 'morning', 'Eastern') === null,
  );
  check(
    'zonedTimeToUtc: 12-hour time with AM/PM (not the strict 24-hour format the AI is told to use) returns null rather than misreading it',
    zonedTimeToUtc('2026-09-30', '10:00 AM', 'Eastern') === null,
  );

  // ── fallbackDispositionFromEndedReason: conservative, never invents interest ──
  check(
    "fallbackDispositionFromEndedReason: a voicemail-detected endedReason maps to 'voicemail'",
    fallbackDispositionFromEndedReason('voicemail') === 'voicemail',
  );
  check(
    "fallbackDispositionFromEndedReason: Vapi's actual 'voicemail' endedReason variant maps to 'voicemail'",
    fallbackDispositionFromEndedReason('customer-busy-voicemail') === 'voicemail',
  );
  check(
    "fallbackDispositionFromEndedReason: Vapi's 'customer-did-not-answer' maps to 'no_answer'",
    fallbackDispositionFromEndedReason('customer-did-not-answer') === 'no_answer',
  );
  check(
    "fallbackDispositionFromEndedReason: a hang-up mid-call before any outcome was recorded falls back to 'no_decision', never a guessed positive/negative",
    fallbackDispositionFromEndedReason('customer-ended-call') === 'no_decision',
  );
  check(
    "fallbackDispositionFromEndedReason: an unrecognized/future Vapi endedReason string still fails closed to 'no_decision' rather than throwing",
    fallbackDispositionFromEndedReason('some-new-reason-vapi-adds-later') === 'no_decision',
  );

  // ── The real assistant config make_outbound_call sends to Vapi ───────────
  //
  // execute() returns early (before building callBody) unless VAPI_API_KEY
  // and VAPI_PHONE_NUMBER_ID are set, so both are set here and fetch is
  // stubbed to capture the outbound POST body instead of hitting the real
  // API — the same technique verify-lead-source-tools.ts uses for TomTom.
  const registryMod = (await import(
    path.join(root, 'packages/core/src/tool-registry.ts')
  )) as typeof import('../packages/core/src/tool-registry.js');
  const tools = registryMod.createBuiltinTools(root);
  const makeCall = tools.find((t) => t.name === 'make_outbound_call');
  check('make_outbound_call is registered', Boolean(makeCall));

  if (makeCall) {
    const savedApiKey = process.env.VAPI_API_KEY;
    const savedPhoneId = process.env.VAPI_PHONE_NUMBER_ID;
    process.env.VAPI_API_KEY = 'guard-script-test-key';
    process.env.VAPI_PHONE_NUMBER_ID = 'guard-script-test-phone-id';

    const realFetch = globalThis.fetch;
    let capturedBody: any = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.vapi.ai/call') {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(JSON.stringify({ id: 'guard-call-id', status: 'queued' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in guard: ${url}`);
    }) as typeof fetch;

    try {
      const ctx = { agentId: 'guard', workspaceRoot: root, requestApproval: async () => true } as never;
      await makeCall.execute(
        {
          customerNumber: '+18582264822',
          customerName: 'Guard Prospect',
          assistantPrompt: 'You are a test assistant.',
          firstMessage: 'Hi, is this a test?',
        },
        ctx,
      );

      check('make_outbound_call actually reached the fetch stub (a real callBody was captured)', capturedBody !== null);

      const systemContent: string | undefined = capturedBody?.assistant?.model?.messages?.[0]?.content;
      check(
        "the system prompt is server-prefixed with today's date, not left to whoever wrote assistantPrompt to include it",
        typeof systemContent === 'string' &&
          /^Today's date is \d{4}-\d{2}-\d{2} \(\w+\)\./.test(systemContent) &&
          systemContent.includes('You are a test assistant.'),
        systemContent,
      );

      // Regression pin for the exact production bug reported 2026-09-25:
      // Vapi's Create Call schema rejects `tools` living directly on
      // `assistant` ("assistant.property tools should not exist") because it
      // belongs to the LLM config, nested under assistant.model. This one
      // property being one level too shallow made EVERY outbound call fail
      // with a 400 before it ever dialed.
      check(
        'assistant.tools does NOT exist at the top level (the exact shape Vapi rejects)',
        capturedBody?.assistant?.tools === undefined,
        capturedBody?.assistant?.tools,
      );
      const fns: Array<{ type: string; function: { name: string; parameters: any } }> =
        capturedBody?.assistant?.model?.tools ?? [];
      check('assistant.model.tools exists and is non-empty (tools correctly nested under model)', fns.length > 0);
      const recordFn = fns.find((f) => f.function?.name === 'record_meeting_outcome');
      check('record_meeting_outcome is one of the functions offered to the AI', Boolean(recordFn));
      check(
        'send_checkout_link is still offered too — the new function did not replace it',
        fns.some((f) => f.function?.name === 'send_checkout_link'),
      );

      if (recordFn) {
        const params = recordFn.function.parameters;
        check('record_meeting_outcome requires disposition', params?.required?.includes('disposition'));
        check(
          'record_meeting_outcome does NOT require appointment fields unconditionally (a decline call has none to give)',
          !params?.required?.includes('appointmentDate') && !params?.required?.includes('appointmentTime'),
        );
        const dispositionEnum: string[] | undefined = params?.properties?.disposition?.enum;
        check(
          'disposition enum matches exactly what the webhook handler and callOutcomes.disposition accept',
          Array.isArray(dispositionEnum) &&
            JSON.stringify([...dispositionEnum].sort()) ===
              JSON.stringify(['appointment_booked', 'callback_requested', 'no_decision', 'not_interested'].sort()),
          dispositionEnum,
        );
        const timezoneEnum: string[] | undefined = params?.properties?.appointmentTimezone?.enum;
        check(
          'appointmentTimezone enum matches exactly the four regions zonedTimeToUtc knows how to resolve',
          Array.isArray(timezoneEnum) &&
            JSON.stringify([...timezoneEnum].sort()) ===
              JSON.stringify(['Central', 'Eastern', 'Mountain', 'Pacific'].sort()),
          timezoneEnum,
        );
      }

      // ── A call Vapi rejects must still return a clear error to the caller ──
      // (whether that rejection is durably logged is checked structurally
      // below, since this guard has no live DB to assert an actual insert
      // against).
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://api.vapi.ai/call') {
          return new Response(
            JSON.stringify({ message: ['assistant.property tools should not exist'], error: 'Bad Request', statusCode: 400 }),
            { status: 400 },
          );
        }
        throw new Error(`Unexpected fetch in guard: ${url}`);
      }) as typeof fetch;

      const rejected = await makeCall.execute(
        {
          customerNumber: '+18582264822',
          customerName: 'Guard Prospect',
          assistantPrompt: 'You are a test assistant.',
          firstMessage: 'Hi, is this a test?',
        },
        ctx,
      );
      check(
        'a Vapi-rejected call returns success: false with the status and body surfaced',
        (rejected as any)?.success === false && /Vapi call failed \(400\)/.test((rejected as any)?.error ?? ''),
        rejected,
      );
    } finally {
      globalThis.fetch = realFetch;
      if (savedApiKey === undefined) delete process.env.VAPI_API_KEY;
      else process.env.VAPI_API_KEY = savedApiKey;
      if (savedPhoneId === undefined) delete process.env.VAPI_PHONE_NUMBER_ID;
      else process.env.VAPI_PHONE_NUMBER_ID = savedPhoneId;
    }
  }

  // ── Schema and idempotent-migration DDL stay in lockstep ─────────────────
  const schemaSource = fs.readFileSync(path.join(root, 'lib/db/src/schema.ts'), 'utf8');
  const clientSource = fs.readFileSync(path.join(root, 'lib/db/src/client.ts'), 'utf8');

  check('schema.ts exports callOutcomes', /export const callOutcomes = pgTable\('call_outcomes'/.test(schemaSource));
  check('schema.ts declares callId as NOT NULL (both write paths key on it)', /callId: text\('call_id'\)\.notNull\(\)/.test(schemaSource));
  check(
    'schema.ts enforces uniqueness on callId in Drizzle, matching the DB-level index',
    /callIdUniq: uniqueIndex\('call_outcomes_call_id_unique'\)\.on\(table\.callId\)/.test(schemaSource),
  );
  check('the idempotent DDL creates call_outcomes', clientSource.includes('CREATE TABLE IF NOT EXISTS call_outcomes'));
  check(
    'the idempotent DDL creates the call_id unique index the onConflictDoUpdate upserts rely on',
    /CREATE UNIQUE INDEX IF NOT EXISTS call_outcomes_call_id_unique\s*\n\s*ON call_outcomes \(call_id\)/.test(clientSource),
  );
  check(
    "schema.ts documents the failed_to_dial disposition (added 2026-09-25 so a call Vapi rejects pre-flight is distinguishable from one that connected and reached no_decision)",
    /failed_to_dial/.test(schemaSource),
  );

  // ── make_outbound_call itself must never let an attempt go unlogged ──────
  //
  // Structural rather than executed-against-a-live-DB: this guard has no
  // database, and the tool's own DB write is deliberately try/caught so a
  // logging failure can never mask the real Vapi result -- which also means
  // executing it here would prove nothing about whether the insert call is
  // even present. Pinning the source shape is the same technique already
  // used above for vapi.ts's webhook upserts.
  const registrySource = fs.readFileSync(path.join(root, 'packages/core/src/tool-registry.ts'), 'utf8');
  const mocStart = registrySource.indexOf("name: 'make_outbound_call'");
  const mocEnd = registrySource.indexOf("name: 'get_call_status'");
  check('found the make_outbound_call tool body to inspect', mocStart > -1 && mocEnd > mocStart);
  if (mocStart > -1 && mocEnd > mocStart) {
    const mocBody = registrySource.slice(mocStart, mocEnd);
    check(
      'a Vapi rejection (!res.ok) writes a call_outcomes row with disposition failed_to_dial',
      /if \(!res\.ok\)[\s\S]*?disposition: 'failed_to_dial'/.test(mocBody),
    );
    check(
      "the failed_to_dial row keys on a synthetic id, never a real Vapi call id (Vapi never issued one for a rejected request)",
      /callId: `failed_\$\{randomUUID\(\)\}`/.test(mocBody),
    );
    check(
      'a successfully accepted call writes a call_outcomes row immediately (visible before the webhook ever fires), keyed on the real Vapi call id',
      /callId: data\.id/.test(mocBody) && /disposition: 'no_decision'/.test(mocBody),
    );
    check(
      'the success-path insert upserts rather than risking a duplicate-key throw if the webhook already raced ahead of it',
      /\.onConflictDoUpdate\(\{\s*target: callOutcomes\.callId/.test(mocBody),
    );
    check(
      'both call_outcomes writes are wrapped so a logging failure can never mask or throw over the real tool result',
      (mocBody.match(/catch \(logErr\)/g) ?? []).length >= 2,
    );
  }

  // ── configure_inbound_assistant had the identical `tools` placement bug ──
  // (hits POST/PATCH /assistant rather than /call, but the same Assistant
  // schema — tools belongs under model there too).
  const ciaStart = registrySource.indexOf("name: 'configure_inbound_assistant'");
  const ciaEnd = registrySource.indexOf("name: 'provision_inbound_number'");
  check('found the configure_inbound_assistant tool body to inspect', ciaStart > -1 && ciaEnd > ciaStart);
  if (ciaStart > -1 && ciaEnd > ciaStart) {
    const ciaBody = registrySource.slice(ciaStart, ciaEnd);
    const modelBlockMatch = /model:\s*\{([\s\S]*?)\n\s{10}\},/.exec(ciaBody);
    check(
      'configure_inbound_assistant nests tools inside assistantBody.model, not as a sibling of it (the same shape Vapi rejects)',
      Boolean(modelBlockMatch && /tools:\s*\[/.test(modelBlockMatch[1])),
      modelBlockMatch?.[1],
    );
  }

  // ── The webhook upserts rather than blindly inserting twice ─────────────
  const vapiSource = fs.readFileSync(path.join(root, 'packages/api-server/src/routes/vapi.ts'), 'utf8');
  check(
    'record_meeting_outcome upserts on callId (a mid-call correction updates the same row instead of creating a second one)',
    (vapiSource.match(/onConflictDoUpdate\(\{\s*target: callOutcomes\.callId/g) ?? []).length >= 2,
  );
  // Structural rather than fuzzy-regex: isolate the end-of-call-report case
  // body by its own markers, then check the property inside it that matters
  // -- disposition is set on first INSERT (the fallback) but must be absent
  // from the .onConflictDoUpdate's `set` object, or a second webhook delivery
  // would silently clobber whatever record_meeting_outcome already recorded.
  const eocrStart = vapiSource.indexOf("case 'end-of-call-report':");
  const eocrEnd = vapiSource.indexOf("case 'status-update':");
  check('found the end-of-call-report case body to inspect', eocrStart > -1 && eocrEnd > eocrStart);
  if (eocrStart > -1 && eocrEnd > eocrStart) {
    const eocrBody = vapiSource.slice(eocrStart, eocrEnd);
    const insertMatch = /\.insert\(callOutcomes\)\s*\.values\(\{([\s\S]*?)\}\)\s*\.onConflictDoUpdate\(\{([\s\S]*?)\}\);/.exec(eocrBody);
    check('end-of-call-report upserts callOutcomes with .values(...).onConflictDoUpdate(...)', Boolean(insertMatch));
    if (insertMatch) {
      const [, valuesBlock, conflictBlock] = insertMatch;
      check(
        'the INSERT branch sets a fallback disposition (used only when no row exists yet)',
        /disposition:\s*fallbackDispositionFromEndedReason/.test(valuesBlock),
      );
      const updateSetBlock = /set:\s*\{([\s\S]*?)\}/.exec(conflictBlock)?.[1] ?? conflictBlock;
      check(
        'the UPDATE (onConflictDoUpdate) branch never touches disposition, appointmentAt, or appointment*Raw -- only the function-call path is allowed to set those',
        !/\bdisposition\s*:/.test(updateSetBlock) &&
          !/\bappointmentAt\s*:/.test(updateSetBlock) &&
          !/\bappointmentDateRaw\s*:/.test(updateSetBlock),
        updateSetBlock,
      );
    }
  }

  // ── GET /call-outcomes surfaces the data somewhere a human will look ─────
  const salesOpsSource = fs.readFileSync(path.join(root, 'packages/api-server/src/routes/sales-ops.ts'), 'utf8');
  check(
    "sales-ops.ts registers GET /call-outcomes",
    /router\.get\('\/call-outcomes'/.test(salesOpsSource),
  );
  check(
    'the ?upcoming=true path filters to appointment_booked rows in the future, not just any row',
    /eq\(callOutcomes\.disposition, 'appointment_booked'\)/.test(salesOpsSource) &&
      /gte\(callOutcomes\.appointmentAt, new Date\(\)\)/.test(salesOpsSource),
  );

  // ── Blind audit calls use real fresh leads but dial only the operator ────────
  check(
    'sales-ops.ts registers POST /audit-call',
    /router\.post\('\/audit-call'/.test(salesOpsSource),
  );
  check(
    'audit selection is random and limited to rows sourced in the preceding 24 hours',
    /Date\.now\(\) - 24 \* 60 \* 60 \* 1000/.test(salesOpsSource) &&
      /orderBy\(sql`random\(\)`\)/.test(salesOpsSource),
  );
  check(
    'audit calls dial only TELNYX_OWNER_NUMBER, never the researched lead phone',
    /normalizeE164\(process\.env\.TELNYX_OWNER_NUMBER\)/.test(salesOpsSource) &&
      /customerNumber: ownerNumber/.test(salesOpsSource) &&
      !/audit-call[\s\S]{0,9000}customerNumber:\s*lead\.contactPhone/.test(salesOpsSource),
  );
  check(
    'audit response remains blind while returning an opaque lead id for no-repeat tracking',
    /Keep the audit blind/.test(salesOpsSource) &&
      /auditLeadId: lead\.id/.test(salesOpsSource),
  );
  check(
    'blind audit prompt sells a 15-minute appointment and requires structured outcome capture',
    /15-minute walkthrough\/demo/.test(salesOpsSource) &&
      /record_meeting_outcome/.test(salesOpsSource) &&
      /primary objective is NOT to close a subscription/.test(salesOpsSource),
  );

  console.log(
    failures === 0
      ? '\n✅ Call outcome capture verified.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
