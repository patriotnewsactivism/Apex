// Line activity: open/close "busy" records that drive the Sales Ops lamps.
// Lives in core so every dialer (tool registry, Sales Ops /call, campaigns) and
// every end-of-call webhook can report into the same table without api-server
// being a dependency of core.
import crypto from 'crypto';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { db, lineCalls } from '@workspace/db';

/** Longest a call can legitimately run (assistant time_limit_secs is 1800). */
const STALE_AFTER_MS = 35 * 60 * 1000;

export interface PhoneLine {
  number: string;
  label: string;
  /** What this line is for, so the lamp can be color-coded by purpose. */
  kind: 'outbound-sales' | 'inbound' | 'voice';
}

/**
 * Our owned numbers. Defaults mirror the Telnyx account; override with
 * APEX_PHONE_LINES as JSON ([{number,label,kind}]) without a redeploy of code.
 */
const DEFAULT_LINES: PhoneLine[] = [
  // Cartesia dials every outbound sales call from this number
  // (APEX_CARTESIA_CALLER_NUMBER), which is also the Don Voice line, so a
  // sales call in progress ties up this number for inbound callers too.
  { number: '+18329757665', label: 'Don Voice / Sales outbound', kind: 'outbound-sales' },
  { number: '+13466461352', label: 'Cartesia Agent A', kind: 'outbound-sales' },
  { number: '+12813065750', label: 'Cartesia Agent B', kind: 'outbound-sales' },
  { number: '+18323071234', label: 'Apex Front Desk', kind: 'inbound' },
  { number: '+13466460065', label: 'BuildMyBot Corporate', kind: 'inbound' },
];

export function configuredLines(): PhoneLine[] {
  const raw = process.env.APEX_PHONE_LINES;
  if (!raw) return DEFAULT_LINES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_LINES;
    const lines = parsed
      .filter((l): l is PhoneLine => Boolean(l) && typeof (l as PhoneLine).number === 'string')
      .map((l) => ({
        number: normalizeNumber(l.number),
        label: typeof l.label === 'string' && l.label ? l.label : l.number,
        kind: (['outbound-sales', 'inbound', 'voice'] as const).includes(l.kind) ? l.kind : 'inbound',
      }));
    return lines.length ? lines : DEFAULT_LINES;
  } catch {
    return DEFAULT_LINES;
  }
}

export function normalizeNumber(raw: string): string {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export interface LineCallStart {
  lineNumber: string;
  direction: 'inbound' | 'outbound';
  source: string;
  remoteNumber?: string | null;
  remoteName?: string | null;
  callId?: string | null;
}

/**
 * Open a busy record for a line. Idempotent on callId, so the dial path and the
 * call-start hook can both report the same call without double-counting.
 * Never throws: a lamp failing to light must not break call handling.
 */
export async function markLineBusy(start: LineCallStart): Promise<void> {
  try {
    const lineNumber = normalizeNumber(start.lineNumber);
    if (!lineNumber) return;
    await db
      .insert(lineCalls)
      .values({
        id: crypto.randomUUID(),
        lineNumber,
        direction: start.direction,
        remoteNumber: start.remoteNumber ? normalizeNumber(start.remoteNumber) : null,
        remoteName: start.remoteName ?? null,
        callId: start.callId ?? null,
        source: start.source,
        startedAt: new Date(),
      })
      .onConflictDoNothing();
  } catch (err) {
    console.warn('[phone-lines] markLineBusy failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Close the open record(s) for a call. Matches by callId when we have it, else
 * closes the newest open record on that line (covers providers that report a
 * different id at hangup than at start).
 */
export async function markLineFree(end: {
  callId?: string | null;
  lineNumber?: string | null;
  reason?: string | null;
}): Promise<number> {
  try {
    const now = new Date();
    const reason = end.reason ?? 'ended';
    if (end.callId) {
      const closed = await db
        .update(lineCalls)
        .set({ endedAt: now, endReason: reason })
        .where(and(eq(lineCalls.callId, end.callId), isNull(lineCalls.endedAt)))
        .returning({ id: lineCalls.id });
      if (closed.length) return closed.length;
    }
    const lineNumber = end.lineNumber ? normalizeNumber(end.lineNumber) : '';
    if (!lineNumber) return 0;
    const [newest] = await db
      .select({ id: lineCalls.id })
      .from(lineCalls)
      .where(and(eq(lineCalls.lineNumber, lineNumber), isNull(lineCalls.endedAt)))
      .orderBy(desc(lineCalls.startedAt))
      .limit(1);
    if (!newest) return 0;
    await db.update(lineCalls).set({ endedAt: now, endReason: reason }).where(eq(lineCalls.id, newest.id));
    return 1;
  } catch (err) {
    console.warn('[phone-lines] markLineFree failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/** Close records left open past the hard call limit. */
export async function sweepStaleLineCalls(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const swept = await db
    .update(lineCalls)
    .set({ endedAt: new Date(), endReason: 'stale_swept' })
    .where(and(isNull(lineCalls.endedAt), lt(lineCalls.startedAt, cutoff)))
    .returning({ id: lineCalls.id });
  return swept.length;
}
