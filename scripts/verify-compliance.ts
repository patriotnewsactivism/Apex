import { sql } from 'drizzle-orm';
import { db } from '@workspace/db';
import { evaluateOutboundAction } from '../packages/core/src/compliance/evaluator';

async function run() {
  console.log('--- Compliance Gatekeeper Verification ---');

  const orgId = '00000000-0000-0000-0000-000000000001';
  const contactId = '00000000-0000-0000-0000-000000000002';
  const cleanPhone = '+15559990001';
  const suppressedPhone = '+15559990002';
  const cleanEmail = 'prospect@example.com';
  const suppressedEmail = 'optout@example.com';

  console.log('Seeding compliance test state in Neon...');
  await db.execute(sql`
    INSERT INTO contacts (id, organization_id, first_name, last_name, email, phone_e164, status, timezone)
    VALUES (${contactId}::uuid, ${orgId}::uuid, 'Test', 'Contact', ${cleanEmail}, ${cleanPhone}, 'active', 'America/New_York')
    ON CONFLICT (id) DO UPDATE SET status = 'active', timezone = 'America/New_York';

    DELETE FROM suppressions WHERE organization_id = ${orgId}::uuid;

    INSERT INTO suppressions (organization_id, phone_e164, channel, reason, source)
    VALUES (${orgId}::uuid, ${suppressedPhone}, 'phone', 'dnc', 'compliance-test');

    INSERT INTO suppressions (organization_id, email, channel, reason, source)
    VALUES (${orgId}::uuid, ${suppressedEmail}, 'email', 'opt_out', 'compliance-test');
  `);

  // Test 1: Suppressed phone blocked
  const res1 = await evaluateOutboundAction({
    organizationId: orgId,
    contactId,
    channel: 'phone',
    destination: suppressedPhone,
  });
  console.assert(res1.decision === 'deny', 'Test 1 Failed: Suppressed phone must be denied');
  console.log('  ? Test 1: Suppressed phone touch blocked (code: ' + res1.reasons[0].code + ')');

  // Test 2: Suppressed email blocked
  const res2 = await evaluateOutboundAction({
    organizationId: orgId,
    contactId,
    channel: 'email',
    destination: suppressedEmail,
  });
  console.assert(res2.decision === 'deny', 'Test 2 Failed: Suppressed email must be denied');
  console.log('  ? Test 2: Suppressed email touch blocked (code: ' + res2.reasons[0].code + ')');

  // Test 3: TCPA out-of-hours blocked (3:00 AM EDT)
  const nightTime = new Date('2026-09-18T07:00:00Z');
  const res3 = await evaluateOutboundAction({
    organizationId: orgId,
    contactId,
    channel: 'phone',
    destination: cleanPhone,
    scheduledTime: nightTime,
    timezone: 'America/New_York',
  });
  console.assert(res3.decision === 'deny', 'Test 3 Failed: Night call must be denied');
  console.assert(res3.reasons.some(r => r.code === 'OUTSIDE_CALLING_WINDOW'), 'Missing OUTSIDE_CALLING_WINDOW');
  console.log('  ? Test 3: TCPA night-time call blocked (permitted window: 08:00-21:00)');

  // Test 4: Permitted daytime touch allowed (2:00 PM EDT)
  const dayTime = new Date('2026-09-18T18:00:00Z');
  const res4 = await evaluateOutboundAction({
    organizationId: orgId,
    contactId,
    channel: 'phone',
    destination: cleanPhone,
    scheduledTime: dayTime,
    timezone: 'America/New_York',
  });
  console.assert(res4.decision === 'allow', 'Test 4 Failed: Daytime clean call must be allowed');
  console.log('  ? Test 4: Clean daytime outbound call allowed');

  console.log('\n? All Compliance Gatekeeper tests PASS');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Compliance tests failed:', err);
    process.exit(1);
  });
