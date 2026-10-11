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

  // ── CRM phase 1: the parts you work in every day ─────────────────────────
  const operator = read('packages/core/src/crm/operator.ts');
  // Agents hold the same admin bearer token as a script. None of the phase-1
  // write paths may be reachable from an agent tool, and the tools module must
  // not import the module that holds them.
  const writePaths = [
    'createContact',
    'updateContact',
    'setContactTags',
    'setLifecycleStage',
    'logManualCall',
    'createTask',
    'completeTask',
    'cancelTask',
    'rescheduleTask',
    'liftSuppression',
    'applyResearchedLeadImport',
    'undoResearchedLeadImport',
  ];
  for (const name of writePaths) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(tools), false, `agents cannot call ${name}`);
  }
  assert.equal(/from '\.\/operator\.js'/.test(tools), false, 'the agent tools do not import the operator write module');
  // The privileged writes check the actor at the write path, not only at the
  // route, so a future caller cannot reach them with an agent's token.
  assert.ok(operator.includes('lifecycleStageChangeAllowed'), 'status and opt-out writes check the actor');
  assert.ok(pure.includes('lifecycleStageChangeAllowed'), 'the actor rule lives in the pure rules');
  assert.ok(pure.includes("'churned'"), 'the client status list is defined once');
  assert.ok(operator.includes('CONTACT_LIFECYCLE_STAGES'), 'an unknown client status is refused');
  assert.ok(operator.includes('insertTimelineEvent'), 'every phase-1 write appends to the history');
  assert.ok(operator.includes('auditEvents'), 'every phase-1 write is audited');
  // A lifted opt-out must stop blocking in every place that reads one.
  for (const file of [
    'packages/core/src/send-safeguard-store.ts',
    'packages/core/src/outbound-compliance-guard.ts',
    'packages/core/src/revenue-ops/campaign-engine.ts',
    'packages/api-server/src/routes/cartesia-sales.ts',
  ]) {
    assert.ok(read(file).includes('liftedAt'), `${file} ignores a lifted opt-out`);
  }
  // Privileged routes must ask for the operator dashboard session.
  const routes = read('packages/api-server/src/routes/crm.ts');
  for (const route of ["'/contacts/:id/lifecycle'", "'/suppressions/:id/lift'", "'/leads/import'", "'/leads/import/:batchId/undo'"]) {
    const at = routes.indexOf(`router.post(${route}`);
    assert.ok(at > 0, `route ${route} exists`);
    const body = routes.slice(at, at + 3200);
    const end = body.indexOf('\n  router.');
    const handler = end > 0 ? body.slice(0, end) : body;
    assert.ok(
      handler.includes('requireOperatorSession'),
      `${route} requires the operator dashboard session`,
    );
  }
  // The lists and the export carry the client status.
  const store = read('packages/core/src/crm/store.ts');
  assert.ok(store.includes('lifecycleStage'), 'the contact list filters on the client status');
  assert.ok(store.includes('followUpDueToday'), 'the contact list filters on a due follow-up');
  assert.ok(store.includes("'client_status'"), 'the CSV export carries the client status');
  // The phase-1 migration is additive and applied at boot with the rest.
  const phase1Sql = read('lib/db/drizzle/20261011_crm_phase1.sql');
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(phase1Sql), false, 'the phase 1 migration is additive');
  assert.ok(phase1Sql.includes('ADD COLUMN IF NOT EXISTS lifecycle_stage'), 'contacts gain a client status');
  assert.ok(phase1Sql.includes('crm_tasks'), 'follow-up tasks have a table');
  assert.ok(phase1Sql.includes('crm_lead_import_rows'), 'the lead copy is recorded per lead');
  assert.ok(phase1Sql.includes('lifted_at'), 'an opt-out can be lifted, not deleted');
  assert.ok(phase1Sql.includes('20261011_crm_phase1_lifecycle_backfill'), 'the status backfill runs exactly once');
  assert.ok(
    read('lib/db/src/crm-migration.ts').includes('20261011_crm_phase1.sql'),
    'the phase 1 migration is applied at boot',
  );
  assert.ok(read('packages/core/src/crm/index.ts').includes("'./operator.js'"), 'the write paths are exported for the routes');

  // ── CRM phase 2: the pipeline and the company page ───────────────────────
  const pipeline = read('packages/core/src/crm/pipeline.ts');
  for (const name of ['createDeal', 'updateDeal', 'moveDeal', 'closeDeal']) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(tools), false, `agents cannot call ${name}`);
  }
  assert.equal(/from '\.\/pipeline\.js'/.test(tools), false, 'the agent tools do not import the pipeline write module');
  // A win is what turns a contact into a client, so it carries the same
  // authority as a client-status change.
  assert.ok(pipeline.includes('lifecycleStageChangeAllowed'), 'closing a deal as won checks the actor');
  assert.ok(pipeline.includes('DEFAULT_PIPELINE_STAGES'), 'the board has default stages to seed');
  assert.ok(pipeline.includes('unassigned'), 'the board shows deals that have no stage');
  assert.ok(read('packages/api-server/src/routes/crm.ts').includes('pipelineBoard'), 'the pipeline route serves the board');
  const phase2Sql = read('lib/db/drizzle/20261012_crm_phase2.sql');
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(phase2Sql), false, 'the phase 2 migration is additive');
  assert.ok(phase2Sql.includes('expected_close_at'), 'a deal has an expected close date');
  assert.ok(phase2Sql.includes('closed_at'), 'a deal records when it closed');
  assert.ok(phase2Sql.includes('WHERE NOT EXISTS'), 'the stage seed never overwrites a stage that exists');
  assert.ok(
    read('lib/db/src/crm-migration.ts').includes('20261012_crm_phase2.sql'),
    'the phase 2 migration is applied at boot',
  );

  // ── CRM phase 3: the intelligence layer ─────────────────────────────────
  const insights = read('packages/core/src/crm/insights.ts');
  const scoring = read('packages/core/src/crm/scoring.ts');
  const reporting = read('packages/core/src/crm/reporting.ts');
  for (const name of ['generateContactInsight', 'completeWithModel', 'saveView', 'deleteSavedView']) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(tools), false, `agents cannot call ${name}`);
  }
  assert.equal(/from '\.\/insights\.js'/.test(tools), false, 'the agent tools do not import the insight module');
  assert.equal(/from '\.\/saved-views\.js'/.test(tools), false, 'the agent tools do not import the saved-view module');
  // Generating a summary spends a model call, so it needs the operator and it
  // refuses before the call when there is no capacity.
  assert.ok(insights.includes('Only Matthew can generate a contact summary'), 'only the operator generates a summary');
  assert.ok(insights.includes('llmCapacityAvailableNow'), 'generation checks capacity before calling a model');
  assert.ok(insights.includes('sourceEvents'), 'a stored summary records how much history it saw');
  assert.ok(insights.includes('stale'), 'a stored summary can be reported as stale');
  assert.ok(insights.includes('parseInsightResponse'), 'the stored summary is parsed from the model answer, never written here');
  // The score is arithmetic over records, with the reasons kept.
  assert.ok(pure.includes('scoreContact') && pure.includes('SCORE_BANDS'), 'the scoring rules are pure');
  assert.ok(scoring.includes('scoreContacts'), 'the score is computed from the contact records');
  assert.ok(scoring.includes('doNotContact'), 'a suppressed contact cannot score');
  // The funnel is derived from the audit trail, not from a stored counter.
  assert.ok(reporting.includes('deal.stage_changed'), 'the funnel is derived from the deal audit trail');
  assert.ok(reporting.includes('companies.industry'), 'reply rates are broken down by industry');
  const phase3Sql = read('lib/db/drizzle/20261013_crm_phase3.sql');
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(phase3Sql), false, 'the phase 3 migration is additive');
  assert.ok(phase3Sql.includes('crm_contact_insights'), 'summaries have a table');
  assert.ok(phase3Sql.includes('crm_saved_views'), 'saved views have a table');
  assert.ok(
    read('lib/db/src/crm-migration.ts').includes('20261013_crm_phase3.sql'),
    'the phase 3 migration is applied at boot',
  );
}

/**
 * The scoring rules are arithmetic, so they are checked here without a database:
 * this is the part of the intelligence layer that must be reproducible.
 */
async function scoringChecks(): Promise<void> {
  const { emptyScoreInput, scoreBand, scoreContact } = await import('../packages/core/src/crm/pure.js');
  assert.equal(scoreBand(0), 'cold');
  assert.equal(scoreBand(34), 'cold');
  assert.equal(scoreBand(35), 'warm');
  assert.equal(scoreBand(64), 'warm');
  assert.equal(scoreBand(65), 'hot');
  assert.equal(scoreBand(100), 'hot');

  assert.equal(scoreContact(emptyScoreInput()).score, 0, 'a blank contact has no score');

  const blocked = scoreContact(emptyScoreInput({
    doNotContact: true,
    hasEmail: true,
    hasPhone: true,
    replies: 9,
    openDeals: 1,
    openDealValueUsd: 50_000,
  }));
  assert.equal(blocked.score, 0, 'do-not-contact scores zero whatever else is true');
  assert.equal(blocked.reasons.length, 0);
  assert.ok(blocked.blocked?.includes('do-not-contact'));

  const cold = scoreContact(emptyScoreInput({ hasEmail: true }));
  assert.equal(cold.band, 'cold');
  assert.ok(cold.reasons.some((reason) => reason.label === 'has an email address'));

  const hot = scoreContact(emptyScoreInput({
    hasEmail: true,
    hasPhone: true,
    verifiedIdentifier: true,
    replies: 3,
    daysSinceLastReply: 2,
    outboundTouches: 4,
    daysSinceLastContact: 3,
    openDeals: 1,
    openDealValueUsd: 20_000,
    followUpDueToday: true,
    industry: 'publishing',
    lifecycleStage: 'client',
    leadQualificationScore: 90,
  }));
  assert.equal(hot.band, 'hot');
  assert.ok(hot.score <= 100, 'a score never exceeds 100');
  assert.deepEqual(
    hot.reasons.map((reason) => reason.points),
    [...hot.reasons.map((reason) => reason.points)].sort((a, b) => b - a),
    'reasons come back biggest first',
  );

  const churned = scoreContact(emptyScoreInput({
    hasEmail: true,
    hasPhone: true,
    replies: 3,
    openDeals: 1,
    openDealValueUsd: 20_000,
    lifecycleStage: 'churned',
  }));
  const client = scoreContact(emptyScoreInput({
    hasEmail: true,
    hasPhone: true,
    replies: 3,
    openDeals: 1,
    openDealValueUsd: 20_000,
    lifecycleStage: 'client',
  }));
  assert.ok(churned.score < client.score, 'a churned contact scores below a client on the same signals');
  assert.equal(
    client.score - churned.score,
    35,
    'the client bonus and the churned penalty are 35 points apart on the same signals',
  );
  const floor = scoreContact(emptyScoreInput({ lifecycleStage: 'churned' }));
  assert.equal(floor.score, 0, 'the churned penalty floors at zero, never below');
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
  const phase1 = await import('../packages/core/src/crm/index.js');
  const { assertOutboundAllowed } = await import('../packages/core/src/outbound-compliance-guard.js');
  const { crmTasks, crmLeadImports, crmLeadImportRows, suppressions, salesOpportunities, companies: companyTable } = dbMod;

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

  // A send already cleared and released in Pending sends re-checks at the moment
  // of send. A STOP by text after release must still block the queued call.
  const { getSendSafeguard, SendSafeguardError } = await import('../packages/core/src/send-safeguard.js');
  const engine = await getSendSafeguard();
  // Digits only: `stamp` is base 36, and letters would shorten the number
  // below what normalizePhone accepts.
  const heldPhone = `+1504556${String(Date.now()).slice(-4)}`;
  const heldContact = await findOrCreateContact(db, heldPhone, { name: 'Held Call' });
  const releasedCall = async () => {
    const { job, recipients } = await engine.createJob({
      caller: 'tool',
      createdBy: 'verify-crm',
      recipients: [{ channel: 'phone', destination: heldPhone, messageText: 'held call', payload: { kind: 'cartesia_call' } }],
    });
    await engine.confirm(job.id, 'operator-dashboard', 1);
    await engine.confirm(job.id, 'operator-dashboard', 2);
    const recipientId = recipients[0]?.id ?? '';
    await engine.release(job.id, 'operator-dashboard', recipientId);
    return { jobId: job.id, recipientId };
  };
  const control = await releasedCall();
  await engine.assertSendAllowed(control.jobId, heldPhone, 'phone');
  await engine.recordSendResult(control.jobId, control.recipientId, 'sent', `verify-${stamp}`);
  const held = await releasedCall();
  await applyDoNotContact(db, { contactId: heldContact, destination: heldPhone, reason: 'stop', setBy: 'system', channel: 'sms' });
  await assert.rejects(
    () => engine.assertSendAllowed(held.jobId, heldPhone, 'phone'),
    (error: unknown) => error instanceof SendSafeguardError && error.reason === 'suppressed',
    'a released call to a contact who texted STOP is blocked at the moment of send',
  );

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

  // ── CRM phase 1 against the real database ────────────────────────────────
  const stamp2 = `${stamp}p1`;
  const made = await phase1.createContact({
    actor: OPERATOR_ACTOR,
    firstName: 'Verify',
    lastName: `PhaseOne ${stamp2}`,
    organizationName: `Phase One Desk ${stamp2}`,
    email: `phase1-${stamp2}@example.com`,
    phone: '+15125550101',
    city: 'Baton Rouge',
    tags: ['newsroom'],
  });
  const [madeRow] = await db.select().from(contacts).where(eq(contacts.id, made.contactId));
  assert.equal(madeRow?.lifecycleStage, 'prospect', 'a hand-made contact starts as a prospect');
  const edited = await phase1.updateContact({
    contactId: made.contactId,
    actor: OPERATOR_ACTOR,
    patch: { city: 'New Orleans', notes: 'edited by verify' },
  });
  assert.deepEqual([...edited.changed].sort(), ['city', 'notes']);
  await assert.rejects(
    () => phase1.createContact({
      actor: OPERATOR_ACTOR,
      organizationName: 'Duplicate Desk',
      email: `phase1-${stamp2}@example.com`,
    }),
    /already on another contact/,
    'a duplicate address names the contact that holds it',
  );
  const tagged = await phase1.setContactTags({ contactId: made.contactId, actor: OPERATOR_ACTOR, add: ['Tier-A'] });
  assert.deepEqual([...tagged.tags].sort(), ['newsroom', 'tier-a']);

  // Client status: refused for anyone but Matthew, logged twice when it lands.
  await assert.rejects(
    () => phase1.setLifecycleStage({ contactId: made.contactId, stage: 'qualified', actor: 'sales-bot' }),
    /Only Matthew/,
  );
  const [beforeMove] = await db.select().from(contacts).where(eq(contacts.id, made.contactId));
  assert.equal(beforeMove?.lifecycleStage, 'prospect', 'a refused status move changes nothing');
  await assert.rejects(
    () => phase1.setLifecycleStage({ contactId: made.contactId, stage: 'vip', actor: OPERATOR_ACTOR }),
    /Unknown client status/,
  );
  const movedTo = await phase1.setLifecycleStage({
    contactId: made.contactId,
    stage: 'qualified',
    actor: OPERATOR_ACTOR,
    reason: 'answered the phone',
  });
  assert.equal(movedTo.changed, true);
  const again = await phase1.setLifecycleStage({ contactId: made.contactId, stage: 'qualified', actor: OPERATOR_ACTOR });
  assert.equal(again.changed, false, 'moving to the stage it is already in is a no-op');
  const statusHistory = await getTimeline(made.contactId);
  assert.ok(statusHistory.some((row) => row.eventKind === 'lifecycle_stage'), 'the status move is in the history');
  const statusAudit = await db.select().from(auditEvents).where(and(
    eq(auditEvents.action, 'contact.lifecycle_stage_changed'),
    eq(auditEvents.entityId, made.contactId),
  ));
  assert.equal(statusAudit.length, 1, 'the status move is audited once');
  const qualifiedOnly = await searchContacts({ lifecycleStage: 'qualified', limit: 500 });
  assert.ok(qualifiedOnly.some((row) => row.id === made.contactId), 'the list filters on the client status');

  // A call you made yourself, and follow-ups with a due-today list.
  const loggedCall = await phase1.logManualCall({
    contactId: made.contactId,
    actor: OPERATOR_ACTOR,
    direction: 'outbound',
    outcome: 'spoke to the owner',
    durationSeconds: 300,
  });
  assert.ok(loggedCall.timelineId);
  const callHistory = await getTimeline(made.contactId);
  assert.ok(callHistory.some((row) => row.channel === 'call' && row.eventKind === 'call'), 'the call is in the history');
  const task = await phase1.createTask({
    actor: OPERATOR_ACTOR,
    contactId: made.contactId,
    title: `Ring back ${stamp2}`,
    dueAt: new Date().toISOString(),
    priority: 'high',
  });
  const [afterTask] = await db.select().from(contacts).where(eq(contacts.id, made.contactId));
  assert.ok(afterTask?.nextFollowUpAt, 'an open follow-up sets the next follow-up date');
  const dueToday = await phase1.listDueTasks({});
  assert.ok(dueToday.tasks.some((row) => row.id === task.taskId), 'the follow-up is on the due list');
  assert.ok(dueToday.tasks.some((row) => row.id === task.taskId && row.overdue === false), 'a follow-up due now is not marked overdue');
  const dueFiltered = await searchContacts({ followUpDueToday: true, limit: 500 });
  assert.ok(dueFiltered.some((row) => row.id === made.contactId), 'the list filters on a due follow-up');
  await phase1.completeTask({ taskId: task.taskId, actor: OPERATOR_ACTOR, notes: 'reached them' });
  const [afterDone] = await db.select().from(contacts).where(eq(contacts.id, made.contactId));
  assert.equal(afterDone?.nextFollowUpAt, null, 'completing the last open follow-up clears the date');
  const [doneTask] = await db.select().from(crmTasks).where(eq(crmTasks.id, task.taskId));
  assert.equal(doneTask?.status, 'done');

  // The reviewed copy of researched leads, and its undo.
  await db.insert(researchedLeads).values({
    id: `lead-p1-${stamp2}`,
    companyName: `Phase One Lead ${stamp2}`,
    fitReason: 'phase 1 fixture',
    contactEmail: `phase1-lead-${stamp2}@example.com`,
    researchedByAgentId: 'verify-crm',
  });
  const plan = await phase1.planResearchedLeadImport({ limit: 500 });
  assert.ok(
    plan.rows.some((row) => row.leadId === `lead-p1-${stamp2}` && row.action === 'create'),
    'the preview plans the copy',
  );
  const [beforeCopy] = await db.select({ n: count() }).from(contacts);
  await assert.rejects(() => phase1.applyResearchedLeadImport({ actor: OPERATOR_ACTOR }), /explicit confirmation/);
  const [afterRefusedCopy] = await db.select({ n: count() }).from(contacts);
  assert.equal(afterRefusedCopy?.n, beforeCopy?.n, 'the copy writes nothing without confirmation');
  const applied = await phase1.applyResearchedLeadImport({ actor: OPERATOR_ACTOR, confirm: true, filter: { limit: 500 } });
  assert.ok(applied.created >= 1, 'the reviewed copy creates contacts');
  const importRows = await db.select().from(crmLeadImportRows).where(eq(crmLeadImportRows.batchId, applied.batchId));
  const copiedRow = importRows.find((row) => row.leadId === `lead-p1-${stamp2}`);
  assert.equal(copiedRow?.outcome, 'created');
  const copiedContactId = copiedRow?.contactId ?? '';
  const [copiedContact] = await db.select().from(contacts).where(eq(contacts.id, copiedContactId));
  assert.equal(copiedContact?.lifecycleStage, 'prospect', 'a copied lead arrives as a prospect');
  assert.equal(copiedContact?.source, 'researched-leads');
  assert.equal(copiedContact?.email?.toLowerCase(), `phase1-lead-${stamp2}@example.com`);
  // A second copy of the same leads matches instead of duplicating.
  const secondCopy = await phase1.applyResearchedLeadImport({ actor: OPERATOR_ACTOR, confirm: true, filter: { limit: 500 } });
  assert.equal(secondCopy.created, 0, 'a repeat copy creates nothing new');
  await phase1.undoResearchedLeadImport({ batchId: secondCopy.batchId, actor: OPERATOR_ACTOR });
  // The undo keeps a contact that has activity since the copy.
  await phase1.logManualCall({ contactId: copiedContactId, actor: OPERATOR_ACTOR, direction: 'outbound', outcome: 'touched after the copy' });
  const undone = await phase1.undoResearchedLeadImport({ batchId: applied.batchId, actor: OPERATOR_ACTOR });
  assert.ok(undone.keptReasons.some((item) => item.contactId === copiedContactId), 'the undo keeps a contact that has activity');
  const [stillThere] = await db.select().from(contacts).where(eq(contacts.id, copiedContactId));
  assert.ok(stillThere, 'a touched contact survives the undo');
  const [batchRow] = await db.select().from(crmLeadImports).where(eq(crmLeadImports.id, applied.batchId));
  assert.equal(batchRow?.status, 'undone');
  assert.equal(batchRow?.undoneBy, OPERATOR_ACTOR);
  await assert.rejects(
    () => phase1.undoResearchedLeadImport({ batchId: applied.batchId, actor: OPERATOR_ACTOR }),
    /already undone/,
  );

  // One recorded opt-out, lifted on purpose.
  const optOutPhone = '+15125550202';
  const optOutContactId = await findOrCreateContact(db, optOutPhone, { name: 'Verify Opt Out' });
  await applyDoNotContact(db, { contactId: optOutContactId, reason: 'spoken dnc on the call', setBy: 'verify-crm' });
  const optOuts = await phase1.listContactSuppressions({ contactId: optOutContactId });
  assert.ok(optOuts.length >= 1, 'the recorded opt-out is listed on the contact');
  const optOut = optOuts.find((row) => row.channel === 'all') ?? optOuts[0]!;
  assert.ok(!optOut.liftedAt, 'a fresh opt-out is not lifted');
  const blocked = await assertOutboundAllowed({ channel: 'phone', destination: optOutPhone })
    .then(() => null)
    .catch((error: unknown) => error as Error);
  assert.match(String(blocked instanceof Error ? blocked.message : blocked), /do-not-contact request/i);
  await assert.rejects(
    () => phase1.liftSuppression({ suppressionId: optOut.id, actor: 'sales-bot', reason: 'agent tried' }),
    /Only Matthew/,
  );
  const lifted = await phase1.liftSuppression({
    suppressionId: optOut.id,
    actor: OPERATOR_ACTOR,
    reason: 'verify: the operator took their call',
    alsoClearDoNotContact: true,
  });
  assert.equal(lifted.clearedDoNotContact, true, 'the contact flag is cleared when asked for');
  const [liftedRow] = await db.select().from(suppressions).where(eq(suppressions.id, optOut.id));
  assert.ok(liftedRow?.liftedAt, 'the record is marked lifted, not deleted');
  assert.equal(liftedRow?.liftedBy, OPERATOR_ACTOR);
  assert.equal(liftedRow?.liftReason, 'verify: the operator took their call');
  const [optOutContact] = await db.select().from(contacts).where(eq(contacts.id, optOutContactId));
  assert.equal(optOutContact?.doNotContact, false, 'do-not-contact is cleared');
  const afterLift = await assertOutboundAllowed({ channel: 'phone', destination: optOutPhone })
    .then(() => null)
    .catch((error: unknown) => error as Error);
  assert.doesNotMatch(
    String(afterLift instanceof Error ? afterLift.message : afterLift),
    /do-not-contact request/i,
    'a lifted opt-out no longer blocks that channel',
  );
  const liftHistory = await getTimeline(optOutContactId);
  assert.ok(liftHistory.some((row) => row.eventKind === 'opt_out_lifted'), 'the lift is in the history');
  await assert.rejects(
    () => phase1.liftSuppression({ suppressionId: optOut.id, actor: OPERATOR_ACTOR, reason: 'again' }),
    /already lifted/,
  );

// ── CRM phase 2 against the real database ────────────────────────────────
  const phase2 = await import('../packages/core/src/crm/pipeline.js');
  const stages = await phase2.listPipelineStages();
  assert.ok(stages.length >= 4, 'the board has stages to work with');
  assert.equal(stages[0]?.position, 1, 'stages come back in board order');
  const seededAgain = await phase2.listPipelineStages();
  assert.equal(seededAgain.length, stages.length, 'asking for the stage list twice does not duplicate it');

  const companyId = crypto.randomUUID();
  await dbMod.db.insert(companyTable).values({
    id: companyId,
    organizationId: 'apex',
    name: `Phase Two Publishing ${stamp2}`,
    domain: `phase-two-${stamp2}.example`,
    industry: 'investigative publishing',
  }).onConflictDoNothing();
  const dealContact = await phase1.createContact({
    actor: OPERATOR_ACTOR,
    firstName: 'Verify',
    lastName: `Deal ${stamp2}`,
    organizationName: `Phase Two Publishing ${stamp2}`,
    email: `phase2-${stamp2}@example.com`,
    companyId,
  });
  const deal = await phase2.createDeal({
    actor: OPERATOR_ACTOR,
    name: `Documentary rights ${stamp2}`,
    contactId: dealContact.contactId,
    companyId,
    amount: '12500',
    probability: 0.4,
    expectedCloseAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    nextStep: 'send the updated scope',
  });
  const [dealRow] = await db.select().from(salesOpportunities).where(eq(salesOpportunities.id, deal.dealId));
  assert.equal(dealRow?.status, 'open');
  assert.equal(Number(dealRow?.amountCents), 12500, 'the value is stored in cents');
  assert.equal(dealRow?.stageId, stages[0]?.id, 'a new deal starts in the first stage');
  await assert.rejects(
    () => phase2.createDeal({ actor: OPERATOR_ACTOR, name: 'Bad probability', probability: 4 }),
    /Probability is a fraction/,
  );
  await assert.rejects(
    () => phase2.createDeal({ actor: OPERATOR_ACTOR, name: 'Bad amount', amount: '-12' }),
    /not a usable amount/,
  );

  const board = await phase2.pipelineBoard();
  const firstColumn = board.stages.find((stage) => stage.id === stages[0]?.id);
  assert.ok(firstColumn?.deals.some((row) => row.id === deal.dealId), 'the deal is on the board in its column');
  const boardDeal = firstColumn?.deals.find((row) => row.id === deal.dealId);
  assert.equal(boardDeal?.amountUsd, 12500);
  assert.equal(boardDeal?.companyName, `Phase Two Publishing ${stamp2}`);
  assert.ok(board.open.count >= 1 && board.open.totalUsd >= 12500, 'the board totals the open deals');
  assert.ok(board.open.weightedUsd <= board.open.totalUsd, 'the weighted total is not larger than the plain total');

  const moved = await phase2.moveDeal({ dealId: deal.dealId, actor: OPERATOR_ACTOR, stageId: stages[1]?.id ?? '' });
  assert.equal(moved.to, stages[1]?.id, 'the deal moves to the stage asked for');
  await assert.rejects(() => phase2.moveDeal({ dealId: deal.dealId, actor: OPERATOR_ACTOR, stageId: null }), /needs a stage/);
  await assert.rejects(
    () => phase2.updateDeal({ dealId: deal.dealId, actor: OPERATOR_ACTOR, patch: { stageId: crypto.randomUUID() } }),
    /stage was not found/,
  );
  const dealHistory = await getTimeline(dealContact.contactId);
  assert.ok(dealHistory.some((row) => row.eventKind === 'deal_created'), 'opening a deal is in the contact history');
  assert.ok(dealHistory.some((row) => row.eventKind === 'deal_stage'), 'moving a deal is in the contact history');

  const updated = await phase2.updateDeal({
    dealId: deal.dealId,
    actor: OPERATOR_ACTOR,
    patch: { amount: '9900', nextStep: 'they asked for the archive licence' },
  });
  assert.deepEqual([...updated.changed].sort(), ['amountCents', 'nextStep']);

  // A win requires the operator, because it is what makes the contact a client.
  await assert.rejects(
    () => phase2.closeDeal({ dealId: deal.dealId, actor: 'sales-bot', outcome: 'won', reason: 'agent tried to close' }),
    /Only Matthew can mark a deal won/,
  );
  const [stillOpen] = await db.select().from(salesOpportunities).where(eq(salesOpportunities.id, deal.dealId));
  assert.equal(stillOpen?.status, 'open', 'a refused close changes nothing');
  const won = await phase2.closeDeal({
    dealId: deal.dealId,
    actor: OPERATOR_ACTOR,
    outcome: 'won',
    amount: '9900',
    reason: 'two-year archive licence',
  });
  assert.equal(won.status, 'won');
  assert.equal(won.clientStatusChanged, true, 'a won deal turns its contact into a client');
  const [clientContact] = await db.select().from(contacts).where(eq(contacts.id, dealContact.contactId));
  assert.equal(clientContact?.lifecycleStage, 'client');
  const [wonRow] = await db.select().from(salesOpportunities).where(eq(salesOpportunities.id, deal.dealId));
  assert.ok(wonRow?.closedAt, 'a closed deal records when it closed');
  assert.equal(wonRow?.wonReason, 'two-year archive licence');
  assert.equal(Number(wonRow?.amountCents), 9900, 'the closed value is what was actually agreed');
  const wonHistory = await getTimeline(dealContact.contactId);
  assert.ok(wonHistory.some((row) => row.eventKind === 'deal_won'), 'the win is in the contact history');
  await assert.rejects(
    () => phase2.closeDeal({ dealId: deal.dealId, actor: OPERATOR_ACTOR, outcome: 'lost' }),
    /already won/,
  );

  const wonBoard = await phase2.pipelineBoard();
  assert.ok(wonBoard.closed.won >= 1, 'the board counts the won deal');
  assert.equal((await phase2.listDeals({ companyId })).length, 1, 'a company reads back its own deals');

  const companyRows = await phase2.listCompanies({ query: `Phase Two Publishing ${stamp2}` });
  const companyRow = companyRows.find((row) => row.id === companyId);
  assert.ok(companyRow, 'the company is listed');
  assert.equal(companyRow?.wonValueUsd, 9900, 'the company row totals what it won');
  assert.equal(companyRow?.contactCount, 1, 'the company row counts its contacts');
  const companyPage = await phase2.getCompanyPage({ companyId });
  assert.equal(companyPage.contacts.length, 1);
  assert.equal(companyPage.deals.length, 1);
  assert.equal(companyPage.totals.wonValueUsd, 9900);
  assert.equal(companyPage.totals.wonCount, 1);
  await assert.rejects(() => phase2.getCompanyPage({ companyId: crypto.randomUUID() }), /Company not found/);

// ── CRM phase 3 against the real database ────────────────────────────────
  const phase3 = await import('../packages/core/src/crm/index.js');
  // Scoring reads the records: the contact from phase 1 has an email, a call and
  // a task behind it, so it must score above a blank contact, with reasons.
  const scored = await phase3.scoreContacts([made.contactId, optOutContactId]);
  const madeScore = scored.get(made.contactId);
  assert.ok(madeScore, 'a scored contact comes back');
  assert.ok(madeScore.score > 0, 'a contacted contact scores above zero');
  assert.ok(madeScore.reasons.length > 0, 'the score explains itself');
  assert.ok(madeScore.reasons.some((reason) => reason.label === 'has been contacted'), 'the call is in the score');
  assert.equal(madeScore.band, phase3.scoreBand(madeScore.score), 'the band matches the score');
  const suppressed = await phase3.scoreContacts([optOutContactId]);
  assert.ok((suppressed.get(optOutContactId)?.score ?? 0) >= 0);

  // Reports: the funnel comes from the deal audit trail, and the money from the
  // deals themselves.
  const reports = await phase3.crmReports({ days: 90 });
  assert.ok(reports.funnel.length >= 4, 'the funnel lists the seeded stages');
  assert.equal(reports.funnel[0]?.stageId, stages[0]?.id, 'the funnel starts at the first stage');
  assert.ok(reports.funnel[0]?.reached >= 1, 'the phase 2 deal counts as having reached the first stage');
  assert.ok(reports.funnel[1]?.reached >= 1, 'it reached the second stage when it moved');
  assert.equal(reports.funnel[0]?.conversionFromPrevious, null, 'the first stage has nothing to convert from');
  assert.ok(reports.revenue.wonCount >= 1, 'the won deal is counted');
  assert.ok(reports.revenue.wonUsd >= 9900, 'the won value is the value agreed at close');
  assert.ok(reports.revenue.averageWonUsd > 0);
  assert.equal(typeof reports.replies.totalOutbound, 'number');
  assert.ok(Array.isArray(reports.replies.byChannel));
  assert.ok(reports.replies.byIndustry.some((row) => row.industry.includes('investigative publishing')), 'industry reply rates are grouped by the company industry');
  assert.equal(reports.revenue.lostReasons.filter((row) => row.count <= 0).length, 0, 'no lost reason has a count below one');

  // Saved views: save, reopen, overwrite by name, delete.
  const viewName = `Hot without a call ${stamp2}`;
  const savedView = await phase3.saveView({ actor: OPERATOR_ACTOR, name: viewName, scope: 'contacts', filters: { called: false, minScore: 40 } });
  assert.equal(savedView.created, true);
  const listed = await phase3.listSavedViews({ scope: 'contacts' });
  const savedViewRow = listed.find((view) => view.id === savedView.viewId);
  assert.ok(savedViewRow, 'the saved view comes back in the list');
  assert.deepEqual(savedViewRow?.filters, { called: false, minScore: 40 });
  const again2 = await phase3.saveView({ actor: OPERATOR_ACTOR, name: `${viewName}  `, scope: 'contacts', filters: { lifecycleStage: 'client' } });
  assert.equal(again2.created, false, 'the same name overwrites rather than duplicating');
  assert.equal(again2.viewId, savedView.viewId);
  const afterOverwrite = await phase3.listSavedViews({ scope: 'contacts' });
  assert.equal(afterOverwrite.filter((view) => view.id === savedView.viewId).length, 1, 'the view was updated, not duplicated');
  assert.deepEqual(afterOverwrite.find((view) => view.id === savedView.viewId)?.filters, { lifecycleStage: 'client' });
  await assert.rejects(() => phase3.saveView({ actor: OPERATOR_ACTOR, name: '   ', scope: 'contacts' }), /needs a name/);
  await assert.rejects(() => phase3.saveView({ actor: OPERATOR_ACTOR, name: 'x', scope: 'invoices' }), /Unknown scope/);
  await phase3.deleteSavedView({ viewId: savedView.viewId, actor: OPERATOR_ACTOR });
  assert.equal((await phase3.listSavedViews({ scope: 'contacts' })).some((view) => view.id === savedView.viewId), false, 'the view is gone');
  await assert.rejects(() => phase3.deleteSavedView({ viewId: savedView.viewId, actor: OPERATOR_ACTOR }), /not found/);

  // The reading of a contact: generated from its own history, cached with the
  // model that wrote it, and flagged stale once the history grows.
  assert.equal(await phase3.readInsight(made.contactId), null, 'nothing is cached before it is generated');
  await assert.rejects(
    () => phase3.generateContactInsight({ contactId: made.contactId, actor: 'sales-bot', complete: async () => ({ content: '{}' }) }),
    /Only Matthew can generate a contact summary/,
  );
  const digest = await phase3.contactHistoryDigest(made.contactId);
  assert.ok(digest.totalEvents >= 1, 'the digest reads the history');
  assert.ok(digest.name.length > 0);
  const prompt = phase3.buildInsightPrompt(digest);
  assert.ok(prompt.includes('CONTACT'), 'the prompt carries the contact');
  assert.ok(prompt.includes('HISTORY'), 'the prompt carries the history');
  await assert.rejects(
    () => phase3.generateContactInsight({
      contactId: made.contactId,
      actor: OPERATOR_ACTOR,
      complete: async () => ({ content: 'I could not write that.' }),
    }),
    /expected shape/,
    'a model answer that is not JSON is refused rather than stored',
  );
  assert.equal(await phase3.readInsight(made.contactId), null, 'a refused answer stores nothing');
  await assert.rejects(
    () => phase3.generateContactInsight({
      contactId: made.contactId,
      actor: OPERATOR_ACTOR,
      complete: async () => ({ content: '{"summary":"only a summary"}' }),
    }),
    /without both a summary and a next step/,
  );
  const generated = await phase3.generateContactInsight({
    contactId: made.contactId,
    actor: OPERATOR_ACTOR,
    complete: async () => ({
      content: '{"summary":"They have answered and the terms are with them.","next_step":"Call on Wednesday."}',
      model: 'stub-model',
    }),
  });
  assert.equal(generated.summary, 'They have answered and the terms are with them.');
  assert.equal(generated.stale, false);
  const cached = await phase3.readInsight(made.contactId);
  assert.ok(cached, 'the generated summary is cached');
  assert.equal(cached?.model, 'stub-model');
  assert.equal(cached?.generatedBy, OPERATOR_ACTOR);
  assert.equal(cached?.sourceEvents, digest.totalEvents);
  assert.equal(cached?.stale, false);
  await insertTimelineEvent(db, {
    contactId: made.contactId,
    channel: 'internal',
    direction: 'internal',
    actorType: 'system',
    actorName: 'verify-crm',
    eventKind: 'note',
    bodyText: 'one more row, so the summary is out of date',
    provider: 'crm',
    providerMessageId: `phase3-stale-${stamp2}`,
  });
  const afterNewRow = await phase3.readInsight(made.contactId);
  assert.equal(afterNewRow?.stale, true, 'a summary says so once the history has moved on');
  assert.ok((afterNewRow?.currentEvents ?? 0) > (afterNewRow?.sourceEvents ?? 0));
  const regenerated = await phase3.generateContactInsight({
    contactId: made.contactId,
    actor: OPERATOR_ACTOR,
    complete: async () => ({ content: '{"summary":"Updated read.","next_step":"Send the terms."}', model: 'stub-model' }),
  });
  assert.equal(regenerated.sourceEvents, afterNewRow?.currentEvents, 'regenerating covers the newer rows');
  assert.equal((await phase3.readInsight(made.contactId))?.stale, false);

  const topScored = await phase3.topScoredContacts({ limit: 5, minScore: 1 });
  assert.ok(Array.isArray(topScored));
  assert.ok(topScored.every((row) => row.score.score >= 1), 'the top list respects the floor');
  assert.ok(topScored.every((row, index) => index === 0 || topScored[index - 1]!.score.score >= row.score.score), 'the top list is ordered best first');

  console.log('CRM database checks passed');
}

async function main(): Promise<void> {
  pureChecks();
  await scoringChecks();
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
