/**
 * Guard: verifySvixSignature (packages/api-server/src/routes/resend-webhook.ts)
 * must actually accept a validly-signed Resend/Svix webhook, and must keep
 * rejecting every tampered/wrong-secret/expired/malformed one.
 *
 * A prior version computed the expected signature as
 * `Buffer.from(digest('base64'))` — utf8-encoding the base64 STRING (44
 * bytes for a 32-byte SHA-256 HMAC) instead of decoding it back to raw
 * bytes. That length mismatch made crypto.timingSafeEqual's precondition
 * fail for every real webhook, so verifySvixSignature returned false
 * unconditionally: fail-closed (never a security hole), but APEX has never
 * actually recorded a single delivery/bounce/complaint/open/click event
 * from Resend. This guard proves a valid signature now verifies, and that
 * every rejection case still rejects.
 */
import crypto from 'node:crypto';
import { verifySvixSignature, SVIX_TOLERANCE_SECONDS } from '../packages/api-server/src/routes/resend-webhook.js';

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

function sign(secretBytes: Buffer, svixId: string, svixTimestamp: string, rawBody: Buffer): string {
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
  return crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
}

function main(): void {
  console.log('Verifying Resend/Svix webhook signature checking...\n');

  const secretBytes = crypto.randomBytes(24);
  const secretHeader = `whsec_${secretBytes.toString('base64')}`;
  const svixId = 'msg_2abcXYZ';
  const now = Math.floor(Date.now() / 1000);
  const svixTimestamp = String(now);
  const rawBody = Buffer.from(JSON.stringify({ type: 'email.delivered', data: { email_id: 'evt_1' } }));
  const validSig = sign(secretBytes, svixId, svixTimestamp, rawBody);

  // ── The bug this guard exists for: a real signature must verify ──────────
  check(
    'a validly-signed payload verifies as true (the regression this guard exists for)',
    verifySvixSignature(secretHeader, svixId, svixTimestamp, rawBody, `v1,${validSig}`) === true,
  );

  // ── Secret rotation: multiple space-separated v1 signatures, any match ───
  const otherSecretBytes = crypto.randomBytes(24);
  const otherSig = sign(otherSecretBytes, svixId, svixTimestamp, rawBody);
  check(
    'a valid signature among several space-separated v1 candidates still verifies',
    verifySvixSignature(secretHeader, svixId, svixTimestamp, rawBody, `v1,${otherSig} v1,${validSig}`) === true,
  );

  // ── Fixing acceptance must not weaken rejection ───────────────────────────
  check(
    'a tampered body is rejected',
    verifySvixSignature(secretHeader, svixId, svixTimestamp, Buffer.from('{"type":"tampered"}'), `v1,${validSig}`) === false,
  );
  check(
    'a signature made with the wrong secret is rejected',
    verifySvixSignature(secretHeader, svixId, svixTimestamp, rawBody, `v1,${otherSig}`) === false,
  );
  check(
    'a timestamp older than the replay tolerance is rejected even with a correct signature over it',
    (() => {
      const staleTs = String(now - SVIX_TOLERANCE_SECONDS - 60);
      const staleSig = sign(secretBytes, svixId, staleTs, rawBody);
      return verifySvixSignature(secretHeader, svixId, staleTs, rawBody, `v1,${staleSig}`) === false;
    })(),
  );
  check(
    'a non-base64 signature value does not throw and is rejected',
    verifySvixSignature(secretHeader, svixId, svixTimestamp, rawBody, 'v1,not!!valid==base64') === false,
  );
  check(
    'an unsupported signature version is rejected',
    verifySvixSignature(secretHeader, svixId, svixTimestamp, rawBody, `v2,${validSig}`) === false,
  );
  check(
    'an empty signature header is rejected without throwing',
    verifySvixSignature(secretHeader, svixId, svixTimestamp, rawBody, '') === false,
  );

  if (failures > 0) {
    console.error(`\n${failures} resend-webhook-signature check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll resend-webhook-signature checks passed.');
}

main();
