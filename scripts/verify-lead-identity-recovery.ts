import assert from 'node:assert/strict';
import {
  IDENTITY_RECOVERY_RULE,
  IDENTITY_SETTLED_REASONS,
  identityRecoveryMaxAttempts,
  isRetryableIdentityFailure,
  shouldRejectOnIdentityMismatch,
} from '../packages/background-jobs/src/lead-pipeline.js';

/**
 * Guards the lead-identity recovery lane. The lane exists because the main
 * verify pass stamps its scan version on rows whose homepage fetch never
 * produced a verdict, so a timeout became a permanent answer: 74,954 production
 * rows sat on `unverified / "The operation was aborted due to timeout"` and
 * nothing could ever re-select them. These checks hold the two rules that make
 * the lane safe — a transport accident is retryable and a definitive answer is
 * not, and an operator import is never rejected — plus the bound that stops it
 * retrying a dead domain forever.
 */

function main() {
  // ── A transport accident is retryable; an answer about the business is not ──
  // The exact strings production carries. These must be retryable or the lane
  // fixes nothing; they are raw error messages, so they can never be an
  // enumerated allow-list — which is why the predicate is negative.
  for (const transient of [
    'The operation was aborted due to timeout',
    'fetch failed',
    'http_502',
    'http_503',
    'http_429',
    'http_403',
    'http_405',
    'http_307',
    'ECONNRESET',
    '',            // never judged at all
    undefined,
  ]) {
    assert.equal(isRetryableIdentityFailure(transient), true,
      `a fetch that was never answered must be retryable: ${String(transient)}`);
  }

  // A settled answer is final: retrying a 404 forever is how a backlog becomes
  // a permanent load on other people's servers.
  for (const settled of ['http_404', 'http_410', 'missing_or_invalid_website',
    'homepage_and_industry_verified', 'homepage_identity_verified_industry_unchecked',
    'homepage_does_not_match_target_industry']) {
    assert.equal(isRetryableIdentityFailure(settled), false,
      `a definitive answer must never be retried: ${settled}`);
  }

  // The SQL selector and the TypeScript predicate must not drift: every reason
  // the SQL excludes has to be non-retryable here, and vice versa.
  for (const reason of IDENTITY_SETTLED_REASONS) {
    assert.equal(isRetryableIdentityFailure(reason), false,
      `IDENTITY_SETTLED_REASONS entry ${reason} must be settled in the predicate too`);
  }

  // ── The attempt ledger bounds the retry, it does not enable an infinite loop ──
  assert.equal(identityRecoveryMaxAttempts({} as NodeJS.ProcessEnv), 3);
  assert.equal(identityRecoveryMaxAttempts({ LEAD_IDENTITY_REPAIR_MAX_ATTEMPTS: '1' } as NodeJS.ProcessEnv), 1);
  assert.equal(identityRecoveryMaxAttempts({ LEAD_IDENTITY_REPAIR_MAX_ATTEMPTS: '7' } as NodeJS.ProcessEnv), 7);
  // Clamped, so a typo cannot turn the lane into an unbounded crawler.
  assert.equal(identityRecoveryMaxAttempts({ LEAD_IDENTITY_REPAIR_MAX_ATTEMPTS: '500' } as NodeJS.ProcessEnv), 10);
  assert.equal(identityRecoveryMaxAttempts({ LEAD_IDENTITY_REPAIR_MAX_ATTEMPTS: '0' } as NodeJS.ProcessEnv), 3);
  assert.equal(identityRecoveryMaxAttempts({ LEAD_IDENTITY_REPAIR_MAX_ATTEMPTS: 'nonsense' } as NodeJS.ProcessEnv), 3);

  // ── An operator's list is flagged, never deleted ──────────────────────────
  // The pre-#370 pass rejected imports on industry affinity and destroyed
  // thousands of real businesses. The recovery lane runs over the rows that
  // damage left behind, so it is the last place this must hold.
  assert.equal(shouldRejectOnIdentityMismatch({ status: 'mismatch', isOperatorImport: true, importNameMatch: false }), false,
    'an operator import must never be rejected on a mismatch, whatever the reason');
  assert.equal(shouldRejectOnIdentityMismatch({ status: 'mismatch', isOperatorImport: false, importNameMatch: false }), true,
    'a lane that derived its own name is still cleaned up on a genuine mismatch');
  assert.equal(shouldRejectOnIdentityMismatch({ status: 'mismatch', isOperatorImport: false, importNameMatch: true }), false);
  // Only a mismatch ever rejects — a transport failure must leave status alone.
  for (const status of ['verified', 'unverified'] as const) {
    assert.equal(shouldRejectOnIdentityMismatch({ status, isOperatorImport: false, importNameMatch: false }), false,
      `${status} must never reject a row`);
  }

  // ── The rule stamp is stable: a rename re-opens the backlog, a retry does not ──
  assert.equal(IDENTITY_RECOVERY_RULE, 'identity-recovery-v1');
  assert.ok(IDENTITY_RECOVERY_RULE.length > 0);

  console.log('PASS: lead identity recovery — transient retries are bounded,'
    + ' settled answers stay final, and an operator import is never rejected');
}

main();