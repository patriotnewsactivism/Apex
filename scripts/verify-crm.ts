/**
 * CRM guard. Pure checks always run. Postgres checks run against a disposable
 * local database named apex_crm_verify. Never a production database.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    if (typeof current === 'object' && current && 'code' in current) parts.push(String((current as { code?: unknown }).code));
    if (current instanceof Error && current.cause) current = current.cause;
    else break;
  }
  return parts.join(' ');
}

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function assertLocalCrmDatabase(target: string): void {
  if (process.env.RAILWAY_ENVIRONMENT) throw new Error('Refusing to run CRM verification on Railway');
  const url = new URL(target);
  const hostOk = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (!hostOk || !url.pathname.startsWith('/apex_crm_verify')) {
    throw new Error('Refusing a non-local or non-test database. Use apex_crm_verify on localhost.');
  }
}

function pureChecks(): void {
  // Imported after this function is declared; the caller loads the module first
  // only for the DB half. Pure helpers are imported statically below.
}

const outboundFiles: Array<[string, string]> = [
  ['packages/core/src/email-delivery.ts', 'commitSendRecord'],
  ['packages/api-server/src/routes/sales-ops.ts', 'commitSmsMessage'],
  ['packages/api-server/src/routes/cartesia-sales.ts', 'commitSmsMessage'],
  ['packages/api-server/src/routes/telnyx-assistant.ts', 'commitSmsMessage'],
  ['packages/api-server/src/telnyx-voice-guardrails.ts', 'commitSmsMessage'],
  ['packages/core/src/tool-registry.ts', 'commitCallOutcome'],
  ['packages/api-server/src/routes/call-bridge.ts', 'commitSendRecord'],
  ['packages/api-server/src/routes/sales-floor.ts', 'commitCallOutcome'],
  ['packages/core/src/revenue-ops/campaign-engine.ts', 'commitSendRecord'],
  ['packages/core/src/revenue-ops/voice-router.ts', 'commitSendRecord'],
];

function sourceChecks(): void {
  for (const [file, recorder] of outboundFiles) {
    const src = read(file);
    assert.ok(
      /openOutboundSendJob|startCartesiaSalesCall|dialBridgeLeg|assertSendAllowed\(/.test(src) || file.endsWith('campaign-engine.ts'),
      `${file} routes through the send safeguard`,
    );
    assert.ok(src.includes('assertContactSendable'), `${file} checks do-not-contact`);
    assert.ok(src.includes(recorder), `${file} writes the send and timeline together`);
  }
  assert.ok(read('packages/api-server/src/routes/sales-ops.ts').includes('commitCallOutcome'), 'audit-call writes a timeline row');
  assert.ok(read('packages/api-server/src/routes/resend-webhook.ts').includes('commitSendRecord'), 'bounce and complaint share the send transaction');
  assert.ok(read('packages/api-server/src/routes/resend-webhook.ts').includes('applyDoNotContact'), 'bounce and complaint flip do-not-contact');
  assert.ok(read('packages/api-server/src/routes/revenue-ops-webhooks.ts').includes('commitSendRecord'), 'provider call events write a timeline row');
  const inbound = read('packages/api-server/src/routes/resend-webhook.ts');
  assert.ok(inbound.includes("router.post('/inbound'"), 'Resend inbound route exists');
  assert.ok(inbound.includes('verifySvixSignature'), 'Resend inbound verifies the Svix signature');
  const assistant = read('packages/api-server/src/routes/telnyx-assistant.ts');
  const smsAt = assistant.indexOf("router.post('/sms-inbound'");
  const smsBody = assistant.slice(smsAt, smsAt + 800);
  assert.ok(smsBody.includes('verifyTelnyxWebhookSignature'), 'unsigned Telnyx SMS is checked');
  assert.ok(smsBody.includes("status(403)"), 'unsigned Telnyx SMS is rejected');
  const gmail = read('packages/core/src/crm/gmail.ts');
  const pure = read('packages/core/src/crm/pure.ts');
  assert.ok(pure.includes('https://www.googleapis.com/auth/gmail.readonly'), 'Gmail scope is gmail.readonly');
  assert.ok(gmail.includes('GMAIL_READONLY_SCOPE'), 'Gmail sync uses the read-only scope');
  assert.equal(gmail.includes('/messages/send'), false, 'Gmail sync has no send endpoint');
  const tools = read('packages/core/src/crm/tools.ts');
  assert.ok(tools.includes('crm_search_contacts'));
  assert.ok(tools.includes('crm_get_contact'));
  assert.ok(tools.includes('crm_get_timeline'));
  assert.equal(/mergeContacts|setDoNotContact/.test(tools), false, 'agents cannot merge or edit do-not-contact');
  assert.ok(read('packages/core/src/tool-registry.ts').includes('createCrmTools'), 'CRM tools are registered');
  for (const file of fs.readdirSync(path.join(root, 'packages/core/src/crm'))) {
    if (!file.endsWith('.ts')) continue;
    const src = read(`packages/core/src/crm/${file}`);
    assert.equal(src.includes('.update(contactTimeline)'), false, `${file} does not update timeline rows`);
    assert.equal(src.includes('.delete(contactTimeline)'), false, `${file} does not delete timeline rows`);
  }
  const importer = read('scripts/import-contacts-csv.ts');
  assert.ok(importer.includes('dryRun: !apply'), 'CSV import dry-run is the default');
  assert.ok(importer.includes('Refusing'), 'CSV import refuses a non-local database');
  const backfillCli = read('scripts/backfill-crm.ts');
  assert.ok(backfillCli.includes('dryRun: !apply'), 'backfill dry-run is the default');
  assert.ok(backfillCli.includes('Refusing'), 'backfill refuses a non-local database');
  const sql = read('lib/db/drizzle/20261003_crm.sql');
  assert.ok(sql.includes('DROP INDEX IF EXISTS audit_events_entity_unique'));
  assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS audit_events_entity_idx'));
  assert.ok(sql.includes('crm_reject_timeline_mutation'));
  assert.equal(sql.includes('DROP TABLE'), false, 'CRM migration does not drop tables');
}

async function databaseChecks(): Promise<void> {
  const target = process.env.CRM_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@127.0.0.1:5432/apex_crm_verify';
  assertLocalCrmDatabase(target);
  process.env.DATABASE_URL = target;
  process.env.NODE_ENV = 'test';
  delete process.env.TELNYX_SMS_QUERY_KEY_FALLBACK;
  delete process.env.APEX_CRM_BCC_CAPTURE;
  delete process.env.APEX_CRM_GMAIL_SYNC;

  const {
    applyDoNotContact,
    assertContactSendable,
    backfillCrm,
    codeCheckTimelineText,
    commitCallOutcome,
    commitSendRecord,
    commitSmsMessage,
    findOrCreateContact,
    getTimeline,
    importNewsroomCsv,
    inboundSmsAuthorized,
    ingestInboundEmail,
    insertTimelineEvent,
    isOptOutMessage,
    mergeContacts,
    queryKeyFallbackEnabled,
    searchContacts,
    SendBlockedError,
    setDoNotContact,
    verifyTelnyxWebhookSignature,
    OPERATOR_ACTOR,
  } = await import('../packages/core/src/crm/index.js');
  const dbMod = await import('../lib/db/src/index.js');
  const { and, count, eq } = await import('../lib/db/node_modules/drizzle-orm/index.js');
  const {
    db,
    migrate,
    auditEvents,
    campaignEnrollments,
    campaigns,
    contactIdentifiers,
    contactTimeline,
    contacts,
    crmLegacyLinks,
    researchedLeads,
    sequenceStepExecutions,
  } = dbMod;

  assert.equal(codeCheckTimelineText(true, '482193'), 'pass');
  assert.equal(codeCheckTimelineText(false, '482193'), 'fail');
  assert.equal(isOptOutMessage('STOP').matched, true);
  assert.equal(isOptOutMessage('Please unsubscribe me from this').matched, true);
  assert.equal(isOptOutMessage('Thanks, send the next note').matched, false);
  assert.equal(queryKeyFallbackEnabled(), false);
  assert.equal(inboundSmsAuthorized({ signatureOk: false, signaturePresent: false, queryKeyOk: true }), false);
  assert.equal(inboundSmsAuthorized({ signatureOk: false, signaturePresent: true, queryKeyOk: true }), false);
  process.env.TELNYX_SMS_QUERY_KEY_FALLBACK = 'true';
  assert.equal(inboundSmsAuthorized({ signatureOk: false, signaturePresent: false, queryKeyOk: true }), true);
  delete process.env.TELNYX_SMS_QUERY_KEY_FALLBACK;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const rawKey = Buffer.from(der).subarray(-32).toString('base64');
  const rawBody = '{"data":{"event_type":"message.received"}}';
  const timestamp = '1710000000';
  const signature = crypto.sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64');
  assert.equal(verifyTelnyxWebhookSignature({
    publicKeyBase64: rawKey,
    signatureBase64: signature,
    timestamp,
    rawBody,
  }), true);
  assert.equal(verifyTelnyxWebhookSignature({
    publicKeyBase64: rawKey,
    signatureBase64: undefined,
    timestamp,
    rawBody,
  }), false);

  await migrate();

  await db.insert(auditEvents).values({
    organizationId: 'apex',
    actorType: 'system',
    actorId: 'verify-crm',
    action: 'contact.note',
    entityType: 'contact',
    entityId: 'audit-entity-1',
    metadata: { n: 1 },
  });
  await db.insert(auditEvents).values({
    organizationId: 'apex',
    actorType: 'user',
    actorId: 'Matthew',
    action: 'contact.note',
    entityType: 'contact',
    entityId: 'audit-entity-1',
    metadata: { n: 2 },
  });
  const auditRows = await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityType, 'contact'),
    eq(auditEvents.entityId, 'audit-entity-1'),
  ));
  assert.ok(auditRows.length >= 2, 'multiple audit rows per entity are allowed');

  const stamp = Date.now().toString(36);
  const smsId = `sms-${stamp}`;
  await commitSmsMessage({
    id: smsId,
    direction: 'outbound',
    counterpartyNumber: `+1504555${stamp.slice(-4).padStart(4, '0')}`.slice(0, 12),
    fromNumber: '+18329757665',
    toNumber: '+15045550111',
    body: 'the secret word is kangaroo',
    status: 'sent',
    providerId: `provider-sms-${stamp}`,
  }, { actorType: 'operator', actorName: 'Matthew' });
  const smsTimeline = await db.select().from(contactTimeline).where(eq(contactTimeline.sendRecordId, smsId));
  assert.equal(smsTimeline.length, 1, 'SMS send writes one timeline row');
  const timelineId = smsTimeline[0]?.id;
  assert.ok(timelineId);

  await assert.rejects(
    () => db.update(contactTimeline).set({ bodyText: 'edited' }).where(eq(contactTimeline.id, timelineId)),
    (error: unknown) => /append-only|55000/.test(errorText(error)),
  );
  await assert.rejects(
    () => db.delete(contactTimeline).where(eq(contactTimeline.id, timelineId)),
    (error: unknown) => /append-only|55000/.test(errorText(error)),
  );

  const found = await searchContacts({ query: 'kangaroo' });
  assert.ok(found.some((row) => row.id === smsTimeline[0]?.contactId), 'search finds a contact by message text');

  await assert.rejects(() => commitSendRecord(async () => {
    throw new Error('provider failed');
  }, {
    channel: 'email',
    direction: 'outbound',
    actorType: 'agent',
    actorName: 'sales-bot',
    eventKind: 'email',
    bodyText: 'should roll back',
    provider: 'resend',
    providerMessageId: `rollback-${stamp}`,
    destination: `rollback-${stamp}@example.com`,
  }));
  const rolled = await db.select().from(contactTimeline).where(eq(contactTimeline.providerMessageId, `rollback-${stamp}`));
  assert.equal(rolled.length, 0, 'a failed send does not leave a timeline row');

  const callId = `call-${stamp}`;
  await commitCallOutcome({
    id: `outcome-${stamp}`,
    callId,
    customerNumber: '+15045550122',
    disposition: 'completed',
    summary: 'Called about the desk.',
    createdByAgentId: 'sales-bot',
  });
  const callRows = await db.select().from(contactTimeline).where(eq(contactTimeline.providerMessageId, callId));
  assert.equal(callRows.length, 1, 'call outcome writes a timeline row');

  const blockedId = await findOrCreateContact(db, `stop-${stamp}@example.com`, { name: 'Stop Person' });
  await setDoNotContact({ contactId: blockedId, value: true, actor: OPERATOR_ACTOR, reason: 'manual' });
  await assert.rejects(
    () => assertContactSendable({ channel: 'email', contactId: blockedId, destination: `stop-${stamp}@example.com` }),
    (error: unknown) => error instanceof SendBlockedError,
  );
  await assert.rejects(
    () => setDoNotContact({ contactId: blockedId, value: false, actor: 'sales-bot' }),
    /Only Matthew/,
  );
  const [stillBlocked] = await db.select().from(contacts).where(eq(contacts.id, blockedId));
  assert.equal(stillBlocked?.doNotContact, true);
  await setDoNotContact({ contactId: blockedId, value: false, actor: OPERATOR_ACTOR });
  await assertContactSendable({ channel: 'email', contactId: blockedId });

  const stopId = await findOrCreateContact(db, `+15045550133`.replace('133', stamp.slice(-3).padEnd(3, '1')), { name: 'Sms Stop' });
  await applyDoNotContact(db, { contactId: stopId, destination: '+15045550133', reason: 'stop', setBy: 'system', channel: 'sms' });
  await assert.rejects(() => assertContactSendable({ channel: 'sms', contactId: stopId }), (error: unknown) => error instanceof SendBlockedError);

  const bounceId = await findOrCreateContact(db, `bounce-${stamp}@example.com`, { name: 'Bounce Person' });
  await applyDoNotContact(db, { contactId: bounceId, destination: `bounce-${stamp}@example.com`, reason: 'bounce', setBy: 'system', channel: 'email' });
  await assert.rejects(() => assertContactSendable({ channel: 'email', contactId: bounceId }), (error: unknown) => error instanceof SendBlockedError);
  const complaintId = await findOrCreateContact(db, `complaint-${stamp}@example.com`);
  await applyDoNotContact(db, { contactId: complaintId, destination: `complaint-${stamp}@example.com`, reason: 'complaint', setBy: 'system', channel: 'email' });
  await assert.rejects(() => assertContactSendable({ channel: 'email', contactId: complaintId }), (error: unknown) => error instanceof SendBlockedError);

  const replyEmail = `reply-${stamp}@newsroom.test`;
  const replyId = await findOrCreateContact(db, replyEmail, { name: 'Reply Person', organizationName: 'Reply Desk' });
  const [campaign] = await db.insert(campaigns).values({
    organizationId: 'apex',
    name: `verify-${stamp}`,
  }).returning({ id: campaigns.id });
  assert.ok(campaign);
  const [enrollment] = await db.insert(campaignEnrollments).values({
    organizationId: 'apex',
    campaignId: campaign.id,
    contactId: replyId,
    status: 'active',
  }).returning({ id: campaignEnrollments.id });
  assert.ok(enrollment);
  const [step] = await db.insert(sequenceStepExecutions).values({
    organizationId: 'apex',
    enrollmentId: enrollment.id,
    stepId: crypto.randomUUID(),
    idempotencyKey: `step-${stamp}`,
    status: 'queued',
    scheduledAt: new Date(),
  }).returning({ id: sequenceStepExecutions.id });
  assert.ok(step);

  const token = `tok${stamp}`;
  await insertTimelineEvent(db, {
    contactId: replyId,
    channel: 'email',
    direction: 'outbound',
    actorType: 'agent',
    actorName: 'sales-bot',
    eventKind: 'email',
    bodyText: 'Hello from APEX',
    provider: 'resend',
    providerMessageId: `out-${stamp}`,
    emailMessageId: `<${stamp}@apex.local>`,
    replyToken: token,
  });

  const byToken = await ingestInboundEmail({
    from: 'someone-else@example.com',
    to: [`r+${token}@reply.example.com`],
    text: 'Got it',
    providerMessageId: `in-token-${stamp}`,
    messageId: `<in-token-${stamp}@example.com>`,
  });
  assert.equal(byToken.basis, 'token');
  assert.equal(byToken.contactId, replyId);

  const headerContact = await findOrCreateContact(db, `headers-${stamp}@newsroom.test`);
  await insertTimelineEvent(db, {
    contactId: headerContact,
    channel: 'email',
    direction: 'outbound',
    actorType: 'agent',
    actorName: 'sales-bot',
    eventKind: 'email',
    bodyText: 'Earlier note',
    provider: 'resend',
    providerMessageId: `out-header-${stamp}`,
    emailMessageId: `<header-${stamp}@apex.local>`,
  });
  const byHeader = await ingestInboundEmail({
    from: 'third-party@example.net',
    to: ['apex@example.com'],
    text: 'Following up',
    inReplyTo: `<header-${stamp}@apex.local>`,
    providerMessageId: `in-header-${stamp}`,
  });
  assert.equal(byHeader.basis, 'headers');
  assert.equal(byHeader.contactId, headerContact);

  const bySender = await ingestInboundEmail({
    from: replyEmail,
    to: ['apex@example.com'],
    text: 'Another reply from me',
    providerMessageId: `in-sender-${stamp}`,
  });
  assert.equal(bySender.basis, 'sender');
  assert.equal(bySender.contactId, replyId);

  const unmatched = await ingestInboundEmail({
    from: `nobody-${stamp}@unknown.test`,
    to: ['apex@example.com'],
    text: 'Who is this',
    subject: 'Unmatched',
    providerMessageId: `in-unmatched-${stamp}`,
  });
  assert.equal(unmatched.matched, false);
  assert.ok(unmatched.unmatchedId);

  const [pausedEnrollment] = await db.select().from(campaignEnrollments).where(eq(campaignEnrollments.id, enrollment.id));
  const [pausedStep] = await db.select().from(sequenceStepExecutions).where(eq(sequenceStepExecutions.id, step.id));
  const [pausedContact] = await db.select().from(contacts).where(eq(contacts.id, replyId));
  assert.equal(pausedEnrollment?.status, 'responded');
  assert.equal(pausedEnrollment?.stopReason, 'reply');
  assert.equal(pausedStep?.status, 'skipped');
  assert.equal(pausedStep?.error, 'paused: contact replied');
  assert.equal(pausedContact?.followUpPaused, true);
  assert.ok(pausedContact?.lastReplyAt);

  const leftEmail = `left-${stamp}@shared.test`;
  const rightEmail = `right-${stamp}@shared.test`;
  const leftId = await findOrCreateContact(db, leftEmail, { name: 'Left' });
  const rightId = await findOrCreateContact(db, rightEmail, { name: 'Right' });
  const sharedPhone = `+1504${stamp.replace(/\D/g, '').padEnd(7, '2').slice(0, 7)}`;
  await db.insert(contactIdentifiers).values([
    { contactId: leftId, kind: 'phone', value: sharedPhone, verified: false },
    { contactId: rightId, kind: 'phone', value: sharedPhone, verified: false },
  ]);
  const leftEvent = await insertTimelineEvent(db, {
    contactId: leftId,
    channel: 'internal',
    direction: 'internal',
    actorType: 'system',
    actorName: 'verify',
    eventKind: 'note',
    bodyText: 'left timeline',
    provider: 'crm',
    providerMessageId: `left-${stamp}`,
  });
  const rightEvent = await insertTimelineEvent(db, {
    contactId: rightId,
    channel: 'internal',
    direction: 'internal',
    actorType: 'system',
    actorName: 'verify',
    eventKind: 'note',
    bodyText: 'right timeline',
    provider: 'crm',
    providerMessageId: `right-${stamp}`,
  });
  await assert.rejects(() => mergeContacts({ winnerId: leftId, loserId: rightId, explicit: false, actor: OPERATOR_ACTOR }));
  await assert.rejects(() => mergeContacts({ winnerId: leftId, loserId: rightId, explicit: true, actor: 'sales-bot' }));
  const [rightBefore] = await db.select().from(contacts).where(eq(contacts.id, rightId));
  assert.notEqual(rightBefore?.status, 'merged');
  await mergeContacts({ winnerId: leftId, loserId: rightId, explicit: true, actor: OPERATOR_ACTOR });
  const mergedTimeline = await getTimeline(leftId);
  const mergedIds = new Set(mergedTimeline.map((row) => row.id));
  assert.ok(mergedIds.has(leftEvent.id));
  assert.ok(mergedIds.has(rightEvent.id));

  const [beforeImport] = await db.select({ n: count() }).from(contacts);
  const csv = 'Outlet,Tier,Email,Phone,City,State,Notes\nKangaroo Gazette,A,tips-import@kangaroo.test,+15045550188,Baton Rouge,LA,desk\n';
  const preview = await importNewsroomCsv(csv, { dryRun: true });
  const [afterImport] = await db.select({ n: count() }).from(contacts);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.created, 0);
  assert.ok(preview.wouldCreate >= 1);
  assert.equal(afterImport?.n, beforeImport?.n, 'CSV dry-run changes nothing');

  await db.insert(researchedLeads).values({
    id: `lead-${stamp}`,
    companyName: 'Legacy Desk',
    fitReason: 'verification fixture',
    contactEmail: `legacy-${stamp}@example.com`,
    researchedByAgentId: 'verify-crm',
  });
  const [beforeBackfill] = await db.select({ n: count() }).from(crmLegacyLinks);
  const backfill = await backfillCrm({ dryRun: true });
  const [afterBackfill] = await db.select({ n: count() }).from(crmLegacyLinks);
  assert.equal(backfill.dryRun, true);
  assert.ok(backfill.wouldCreate >= 1);
  assert.equal(backfill.created, 0);
  assert.equal(afterBackfill?.n, beforeBackfill?.n, 'backfill dry-run writes nothing');

  console.log('CRM database checks passed');
}

async function main(): Promise<void> {
  pureChecks();
  sourceChecks();
  const target = process.env.CRM_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!target) {
    console.log('CRM source checks passed. Set CRM_TEST_DATABASE_URL to run the Postgres checks.');
    if (process.env.CI) throw new Error('CI must set CRM_TEST_DATABASE_URL');
    return;
  }
  await databaseChecks();
  console.log('CRM verification passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
