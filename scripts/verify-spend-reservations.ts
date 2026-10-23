/**
 * Paid-spend admission reservations. No live providers, no production ledger.
 *
 * The hard cap stays the existing aggregate metered total (recorded Qwen
 * included). Excluding that history would unlock extra continuity dollars.
 * This API does not admit Qwen direct — the parent routes that separately.
 *
 * Usage:
 *   node packages/core/node_modules/tsx/dist/cli.mjs scripts/verify-spend-reservations.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const scratchRoot = process.env.TMPDIR || tmpdir();
const ledgerDir = mkdtempSync(path.join(scratchRoot, 'apex-spend-reserve-'));
process.env.APEX_SPEND_LEDGER_PATH = path.join(ledgerDir, 'spend-ledger.json');
process.env.DATABASE_URL = 'postgres://guard:***@127.0.0.1:9/no_database';
process.env.APEX_DAILY_SPEND_USD = '2';
process.env.APEX_SPEND_PACING_ENABLED = 'false';
process.env.APEX_SPEND_PACING_BURST_USD = '0';
process.env.APEX_SPEND_CALL_RESERVE_USD = '0';
delete process.env.APEX_SPEND_PRIORITY_RESERVE_PCT;

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

type Priority = 'background' | 'operator';
type Ticket = {
  allowed: boolean;
  reason: string;
  resumeAt: string | null;
  held?: boolean;
  heldMicros?: number;
  heldUsd?: number;
  priority?: Priority;
  processLocal?: boolean;
  distributedHardCap?: boolean;
  release?: () => void;
};

type Ledger = {
  calculateSpendCapacityWindow: (input: {
    capMicros: number;
    spentMicros: number;
    requestedMicros: number;
    at: number;
    pacingEnabled?: boolean;
    burstMicros?: number;
  }) => { allowed: boolean; reason: string; releasedMicros: number; availableMicros: number };
  tryReservePaidSpend?: (
    requestedUsd: number,
    options?: { priority?: Priority; at?: number; pacingEnabled?: boolean; provider?: string },
  ) => Ticket;
  paidSpendCapacityWindow: (
    at?: number,
    pacingEnabled?: boolean,
    priority?: Priority,
    requestedUsd?: number,
  ) => { allowed: boolean; reason: string; availableMicros: number; capMicros: number };
  paidSpendAvailable: (at?: number, pacingEnabled?: boolean, priority?: Priority) => boolean;
  recordSpend: (provider: string, usd: number) => void;
  getSpendLedgerSnapshot: (at?: number) => {
    enforced: boolean;
    spentUsd: number;
    capUsd: number;
    state: string;
    reservedUsd?: number;
    availableUsd?: number;
    backgroundAvailableUsd?: number;
    capScope?: string;
    qwenCountedInCap?: boolean;
    qwenDirectAdmitted?: boolean;
    distributedHardCap?: boolean;
    processLocalReservations?: boolean;
    priorityReservePct?: number;
    dispatch?: {
      processLocal: boolean;
      distributedHardCap: boolean;
      background: { allowed: boolean; reason: string; availableUsd: number };
      operator: { allowed: boolean; reason: string; availableUsd: number };
    };
    providers: Array<{ provider: string; spentUsd: number }>;
  };
  resetSpendLedger?: unknown;
};

const DAY = Date.parse('2031-04-02T12:00:00.000Z');
const NEXT_DAY = Date.parse('2031-04-03T00:00:01.000Z');

function releaseAll(tickets: Array<Ticket | null | undefined>): void {
  for (const ticket of tickets) ticket?.release?.();
}

async function main(): Promise<void> {
  const ledger = (await import(
    pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/core/src/spend-ledger.ts')).href
  )) as Ledger;

  console.log('Pure spend window (unchanged contract)\n');
  const noon = Date.UTC(2030, 0, 15, 12, 0, 0);
  const paced = ledger.calculateSpendCapacityWindow({
    capMicros: 2_000_000,
    spentMicros: 0,
    requestedMicros: 10_000,
    at: noon,
    pacingEnabled: true,
    burstMicros: 0,
  });
  check('pacing at noon releases half the cap', paced.releasedMicros === 1_000_000 && paced.allowed && paced.reason === 'available', paced);
  const overPace = ledger.calculateSpendCapacityWindow({
    capMicros: 2_000_000,
    spentMicros: 1_000_000,
    requestedMicros: 1,
    at: noon,
    pacingEnabled: true,
    burstMicros: 0,
  });
  check('pacing denial is paced, not a cap rewrite', !overPace.allowed && overPace.reason === 'paced', overPace);
  const closed = ledger.calculateSpendCapacityWindow({
    capMicros: 0,
    spentMicros: 0,
    requestedMicros: 1,
    at: noon,
  });
  check('cap 0 stays fail-closed', !closed.allowed && closed.reason === 'disabled', closed);

  const reserve = ledger.tryReservePaidSpend;
  check('exports tryReservePaidSpend', typeof reserve === 'function');
  if (typeof reserve !== 'function') {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
    return;
  }

  const hold = (
    usd: number,
    options?: { priority?: Priority; at?: number; pacingEnabled?: boolean; provider?: string },
  ): Ticket => reserve(usd, options);

  console.log('\nCap 0 / NaN\n');
  process.env.APEX_DAILY_SPEND_USD = '0';
  const zero = hold(0.01, { at: DAY, priority: 'operator', pacingEnabled: false });
  check('cap 0 denies without a hold', zero.allowed === false && zero.reason === 'disabled' && zero.held === false, zero);
  zero.release?.();
  zero.release?.();
  process.env.APEX_DAILY_SPEND_USD = 'nope';
  const nanCap = hold(0.01, { at: DAY, priority: 'operator', pacingEnabled: false });
  check('non-numeric cap fails closed', nanCap.allowed === false && nanCap.reason === 'disabled' && nanCap.held !== true, nanCap);
  nanCap.release?.();
  process.env.APEX_DAILY_SPEND_USD = '2';
  const nanRequest = hold(Number.NaN, { at: DAY, priority: 'operator', pacingEnabled: false });
  check('non-finite request does not hold', nanRequest.allowed === false && nanRequest.held !== true, nanRequest);
  nanRequest.release?.();
  const afterNan = hold(2, { at: DAY, priority: 'operator', pacingEnabled: false });
  check('a rejected NaN request did not consume the cap', afterNan.allowed === true && afterNan.held === true, afterNan);
  afterNan.release?.();

  console.log('\nLast headroom is atomic\n');
  process.env.APEX_DAILY_SPEND_USD = '0.02';
  process.env.APEX_SPEND_PRIORITY_RESERVE_PCT = '0';
  const first = hold(0.02, { at: DAY, priority: 'operator', pacingEnabled: false });
  const second = hold(0.02, { at: DAY, priority: 'operator', pacingEnabled: false });
  check('first of the last $0.02 is held synchronously', first.allowed === true && first.held === true && typeof first.release === 'function' && !(first instanceof Promise), first);
  check('second of the last $0.02 is denied', second.allowed === false && second.held !== true, second);
  second.release?.();
  first.release?.();
  first.release?.();
  const again = hold(0.02, { at: DAY, priority: 'operator', pacingEnabled: false });
  check('idempotent release frees the headroom once', again.allowed === true && again.heldMicros === 20_000, again);
  again.release?.();
  again.release?.();
  const restored = ledger.paidSpendCapacityWindow(DAY, false, 'operator', 0.02);
  check('double release does not credit extra dollars', restored.allowed === true, restored);
  const overflow = ledger.paidSpendCapacityWindow(DAY, false, 'operator', 0.03);
  check('double release does not raise the hard cap', overflow.allowed === false, overflow);
  delete process.env.APEX_SPEND_PRIORITY_RESERVE_PCT;
  process.env.APEX_DAILY_SPEND_USD = '2';

  console.log('\nProtected operator reserve\n');
  const backgroundFull = hold(1.5, { at: DAY, priority: 'background', pacingEnabled: false });
  const backgroundPast = hold(0.01, { at: DAY, priority: 'background', pacingEnabled: false });
  const operatorReserve = hold(0.5, { at: DAY, priority: 'operator', pacingEnabled: false });
  const operatorPast = hold(0.01, { at: DAY, priority: 'operator', pacingEnabled: false });
  check('background gets 75% and no more', backgroundFull.allowed === true && backgroundPast.allowed === false && backgroundPast.reason === 'daily_cap', {
    backgroundFull: backgroundFull.allowed,
    backgroundPast,
  });
  check('operator may use the protected 25% up to the hard cap', operatorReserve.allowed === true && operatorPast.allowed === false, {
    operatorReserve: operatorReserve.allowed,
    operatorPast: operatorPast.allowed,
  });
  releaseAll([backgroundFull, backgroundPast, operatorReserve, operatorPast]);

  process.env.APEX_SPEND_PRIORITY_RESERVE_PCT = '40';
  const forty = hold(1.2, { at: DAY, priority: 'background', pacingEnabled: false });
  const fortyPast = hold(0.01, { at: DAY, priority: 'background', pacingEnabled: false });
  check('explicit 40% reserve leaves background 60%', forty.allowed === true && fortyPast.allowed === false, { forty: forty.allowed, fortyPast: fortyPast.allowed });
  releaseAll([forty, fortyPast]);
  process.env.APEX_SPEND_PRIORITY_RESERVE_PCT = 'nope';
  const fallback = hold(1.5, { at: DAY, priority: 'background', pacingEnabled: false });
  const fallbackPast = hold(0.01, { at: DAY, priority: 'background', pacingEnabled: false });
  check('invalid reserve percent falls back to 25, not an open cap', fallback.allowed === true && fallbackPast.allowed === false, {
    fallback: fallback.allowed,
    fallbackPast: fallbackPast.allowed,
  });
  releaseAll([fallback, fallbackPast]);
  process.env.APEX_SPEND_PRIORITY_RESERVE_PCT = '150';
  const high = hold(1.5, { at: DAY, priority: 'background', pacingEnabled: false });
  const highPast = hold(0.01, { at: DAY, priority: 'background', pacingEnabled: false });
  check('out-of-range reserve percent does not lock or open the cap', high.allowed === true && highPast.allowed === false, highPast);
  releaseAll([high, highPast]);
  delete process.env.APEX_SPEND_PRIORITY_RESERVE_PCT;

  console.log('\nRelease does not replenish past the ceiling\n');
  const opHold = hold(0.4, { at: DAY, priority: 'operator', pacingEnabled: false });
  const bgHold = hold(1.1, { at: DAY, priority: 'background', pacingEnabled: false });
  opHold.release?.();
  opHold.release?.();
  const bgAfter = hold(0.4, { at: DAY, priority: 'background', pacingEnabled: false });
  const bgCredit = hold(0.01, { at: DAY, priority: 'background', pacingEnabled: false });
  check('releasing an operator hold does not let background past 75%', bgAfter.allowed === true && bgCredit.allowed === false, {
    bgAfter: bgAfter.allowed,
    bgCredit: bgCredit.allowed,
  });
  releaseAll([opHold, bgHold, bgAfter, bgCredit]);

  console.log('\nExact lookahead and signature compatibility\n');
  const parked = hold(1, { at: DAY, priority: 'operator', pacingEnabled: false });
  const exactFit = ledger.paidSpendCapacityWindow(DAY, false, 'operator', 1);
  const exactOver = ledger.paidSpendCapacityWindow(DAY, false, 'operator', 1.01);
  const probe = ledger.paidSpendCapacityWindow(DAY, false, 'operator');
  check('fourth arg is an exact lookahead, not the $0.01 probe', exactFit.allowed === true && exactOver.allowed === false, {
    exactFit: exactFit.allowed,
    exactOver: exactOver.allowed,
    probe: probe.allowed,
  });
  check('existing paidSpendAvailable signature still returns a boolean', ledger.paidSpendAvailable(DAY, false) === true);
  check(
    'priority flag selects the background ceiling',
    ledger.paidSpendAvailable(DAY, false, 'background') === true &&
      ledger.paidSpendCapacityWindow(DAY, false, 'background', 0.51).allowed === false,
  );
  parked.release?.();

  console.log('\nPacing is unchanged\n');
  process.env.APEX_SPEND_PACING_ENABLED = 'true';
  const start = Date.UTC(2031, 3, 2, 0, 0, 1);
  const earlyBg = ledger.paidSpendCapacityWindow(start, true, 'background', 0.01);
  const earlyOp = ledger.paidSpendCapacityWindow(start, true, 'operator', 0.01);
  check('early-day pacing still binds both priorities', !earlyBg.allowed && earlyBg.reason === 'paced' && earlyOp.reason === 'paced', {
    earlyBg,
    earlyOp,
  });
  process.env.APEX_SPEND_PACING_ENABLED = 'false';

  console.log('\nDay rollover keeps in-flight holds\n');
  const inflight = hold(0.4, { at: DAY, priority: 'operator', pacingEnabled: false });
  const rolledOver = ledger.paidSpendCapacityWindow(NEXT_DAY, false, 'operator', 1.61);
  const rolledFit = ledger.paidSpendCapacityWindow(NEXT_DAY, false, 'operator', 1.6);
  check('rollover does not replenish an in-flight hold', rolledOver.allowed === false && rolledFit.allowed === true, {
    rolledOver: rolledOver.allowed,
    rolledFit: rolledFit.allowed,
  });
  const rolledSnap = ledger.getSpendLedgerSnapshot(NEXT_DAY);
  check('snapshot keeps reserved dollars after rollover and resets booked spend', rolledSnap.reservedUsd === 0.4 && rolledSnap.spentUsd === 0, rolledSnap);
  inflight.release?.();
  inflight.release?.();
  const afterRoll = ledger.paidSpendCapacityWindow(NEXT_DAY, false, 'operator', 2);
  const afterRollOver = ledger.paidSpendCapacityWindow(NEXT_DAY, false, 'operator', 2.01);
  check('release after rollover frees the hold once and does not credit spend', afterRoll.allowed === true && afterRollOver.allowed === false, {
    afterRoll: afterRoll.allowed,
    afterRollOver: afterRollOver.allowed,
  });

  console.log('\nBook actual once, then release the hold\n');
  const booking = hold(0.1, { priority: 'operator', pacingEnabled: false });
  ledger.recordSpend('openrouter-deepseek-v4-flash-paid', 0.04);
  const during = ledger.getSpendLedgerSnapshot();
  check('until release, admission counts booked spend plus the hold', (during.reservedUsd ?? 0) >= 0.1 && during.spentUsd === 0.04, during);
  booking.release?.();
  booking.release?.();
  const afterBook = ledger.getSpendLedgerSnapshot();
  check('release does not book or refund; recordSpend remains the only charge', afterBook.spentUsd === 0.04 && (afterBook.reservedUsd ?? 1) === 0, afterBook);
  check('provider row is the actual charge', afterBook.providers.some((row) => row.provider === 'openrouter-deepseek-v4-flash-paid' && row.spentUsd === 0.04), afterBook.providers);

  console.log('\nAggregate cap includes recorded Qwen; this API does not admit Qwen direct\n');
  ledger.recordSpend('qwen-dashscope-byok', 0.8);
  const withQwen = ledger.getSpendLedgerSnapshot();
  check('historic Qwen spend stays inside the aggregate cap', withQwen.spentUsd === 0.84 && withQwen.qwenCountedInCap === true, withQwen);
  const bgAfterQwen = hold(0.66, { priority: 'background', pacingEnabled: false });
  const bgPastQwen = hold(0.01, { priority: 'background', pacingEnabled: false });
  check('excluding Qwen would have left $1.46 background; it must not', bgAfterQwen.allowed === true && bgPastQwen.allowed === false, {
    spent: withQwen.spentUsd,
    bgAfterQwen: bgAfterQwen.allowed,
    bgPastQwen: bgPastQwen.allowed,
  });
  releaseAll([bgAfterQwen, bgPastQwen]);
  const qwenTicket = hold(0.01, { provider: 'qwen-dashscope-byok', priority: 'operator', pacingEnabled: false });
  check('Qwen direct is not admitted by this API', qwenTicket.allowed === false && qwenTicket.held !== true, qwenTicket);
  qwenTicket.release?.();
  const continuity = hold(0.01, { priority: 'operator', pacingEnabled: false });
  check('a refused Qwen ticket did not hold continuity headroom', continuity.allowed === true && continuity.held === true, continuity);
  continuity.release?.();

  console.log('\nSnapshot dispatch gating\n');
  const later = Date.parse('2031-04-04T12:00:00.000Z');
  const visible = hold(1.5, { at: later, priority: 'background', pacingEnabled: false });
  const snap = ledger.getSpendLedgerSnapshot(later);
  check('capped continuity is enforced, not observational', snap.enforced === true, snap);
  check('snapshot shows reserved vs background/operator availability', snap.reservedUsd === 1.5 && snap.dispatch?.background.allowed === false && snap.dispatch?.operator.allowed === true, snap.dispatch);
  check('snapshot does not claim a distributed hard cap', snap.distributedHardCap === false && snap.dispatch?.distributedHardCap === false && snap.dispatch?.processLocal === true, snap.dispatch);
  check('scope is the aggregate ledger, and Qwen direct is called out', snap.capScope === 'aggregate-metered-spend' && snap.qwenDirectAdmitted === false, snap);
  check('near the background ceiling, state is not a stale available', snap.state === 'daily_cap', snap.state);
  visible.release?.();

  console.log(failures === 0 ? '\nPASS spend reservations' : `\n${failures} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });
