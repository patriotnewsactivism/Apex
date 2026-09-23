import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'apex-account-test-'));
const fp = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const keyA = 'test-credential-a', keyB = 'test-credential-b', keyC = 'test-credential-c', keyD = 'test-credential-d';
process.env.APEX_REQUEST_LEDGER_PATH = join(dir, 'ledger.json');
process.env.APEX_REQUEST_PACING_ENABLED = 'false';
process.env.APEX_REQUEST_RATE_PER_MIN = '0';
process.env.APEX_ACCOUNT_REQUEST_RATE_PER_MIN = '2';
process.env.OPENROUTER_FREE_API_KEY = keyA;
process.env.OPENROUTER_API_KEY_2 = keyB;
process.env.OPENROUTER_API_KEY_3 = keyC;
process.env.OPENROUTER_API_KEY_4 = keyD;
process.env.APEX_REQUEST_CAPS = 'OPENROUTER_FREE_API_KEY:4,OPENROUTER_API_KEY_2:6';
writeFileSync(process.env.APEX_REQUEST_LEDGER_PATH, JSON.stringify({
  day: new Date().toISOString().slice(0, 10), accounts: {
    [fp(keyA)]: { requests: 2, succeeded: 1 }, [fp(keyB)]: { requests: 2, succeeded: 0 },
  },
}));

async function main() {
  const ledger = await import('../packages/core/src/request-ledger.js');
  ledger.setObservedAccounts(new Map([[fp(keyA), 'account-1'], [fp(keyB), 'account-1'], [fp(keyC), 'account-2'], [fp(keyD), 'account-3']]));
  for (const key of [keyA, keyB]) {
    const window = ledger.accountCapacityWindow(key);
    assert.equal(window.cap, 4);
    assert.equal(window.usedRequests, 4);
    assert.equal(window.allowed, false);
  }
  const rows = ledger.getRequestLedgerSnapshot().accounts;
  assert.equal(rows.length, 4, 'restored key 3 and key 4 credentials remain visible');
  for (const row of rows.filter(row => row.openRouterAccount === 'account-1')) {
    assert.equal(row.requests, 2);
    assert.equal(row.accountRequests, 4);
    assert.equal(row.percentOfCap, 100);
    assert.equal(row.capReached, true);
    assert.equal(row.pacing.allowed, false);
  }
  assert.ok(ledger.accountCapacityWindow(keyC).allowed);
  process.env.APEX_REQUEST_CAPS = 'OPENROUTER_FREE_API_KEY:4';
  assert.equal(ledger.accountCapacityWindow(keyB).allowed, false, 'uncapped sibling cannot escape account cap');
  ledger.setObservedAccounts(null);
  assert.equal(ledger.accountCapacityWindow(keyB).allowed, true, 'never guess unknown identities');
  ledger.setObservedAccounts(new Map([[fp(keyA), 'account-1'], [fp(keyB), 'account-1']]));
  delete process.env.APEX_REQUEST_CAPS;
  const realNow = Date.now;
  const at = realNow();
  try {
    Date.now = () => at;
    ledger.reserveProviderRequest(keyA); // failures count too
    Date.now = () => at + 1000;
    ledger.reserveProviderRequest(keyB);
    assert.equal(ledger.accountCapacityWindow(keyA, at + 1000).allowed, false);
    assert.equal(ledger.accountCapacityWindow(keyB, at + 1000).resumeAt, new Date(at + 60000).toISOString());
    assert.equal(ledger.accountCapacityWindow(keyC, at + 1000).allowed, true);
    assert.equal(ledger.accountCapacityWindow(keyA, at + 60000).allowed, true, 'exact minute boundary releases capacity');
  } finally { Date.now = realNow; }
  assert.equal(ledger.getRequestLedgerSnapshot().totalRequests, 6);
  console.log('Account quotas: shared caps, uncapped sibling, failure accounting, dashboard parity, account RPM and boundary passed.');
}
main().then(() => { rmSync(dir, { recursive: true, force: true }); process.exit(0); }, error => {
  console.error(error); rmSync(dir, { recursive: true, force: true }); process.exit(1);
});
