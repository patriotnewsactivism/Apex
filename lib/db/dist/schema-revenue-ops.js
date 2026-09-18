// ─── Revenue Operations Schema ────────────────────────────────────────────────
// Extension to the core APEX schema for revenue operations functionality.
// See APEX_CHARTER.md and the full spec for domain model details.
//
// This file adds tables for:
// - Provider connections (encrypted credentials)
// - Companies and contacts (with consent/suppression)
// - Campaigns, sequences, and enrollments
// - Interactions (unified timeline)
// - Calls (full call tracking)
// - Missions (plans, steps, task runs)
// - Calendar (meetings, availability)
// - Pipeline (stages, opportunities)
// - Knowledge (sources, documents, chunks)
// - Audit log
// - Budget ledger (usage_ledger)
//
// NOTE: This is a schema extension. Existing tables (projects, goals, tasks,
// approvals, etc.) are reused where possible. See AGENTS.md for the D1 decision:
// missions are a new KIND of APEX goal with mission payload in goal.result,
// NOT a separate missions table.
import { pgTable, text, integer, real, timestamp, jsonb, uuid, uniqueIndex, index, varchar, numeric, } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { projects, goals } from './schema.js';
// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER CONNECTIONS
// ═══════════════════════════════════════════════════════════════════════════════
// Encrypted credential storage for external provider connections (Telnyx, Google,
// Microsoft, HubSpot, etc.). Credentials are encrypted at rest using the app's
// encryption key (derived from APEX_ENCRYPTION_KEY env var).
export const providerConnections = pgTable('provider_connections', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    provider: text('provider').notNull(), // telnyx | google | microsoft | hubspot | ghl | pipedrive | salesforce
    type: text('type').notNull(), // telephony | email | calendar | crm | ai | enrichment
    name: text('name').notNull(),
    encryptedCredentials: jsonb('encrypted_credentials').$type().notNull(),
    externalAccountId: text('external_account_id'),
    status: text('status').notNull().default('connected'), // connected | degraded | disconnected | error
    configuration: jsonb('configuration').$type().notNull().default({}),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastError: jsonb('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgProviderTypeUnique: uniqueIndex('provider_connections_org_provider_type_unique')
        .on(table.organizationId, table.provider, table.type),
    statusIdx: index('provider_connections_status_idx').on(table.status),
}));
export const providerConnectionRelations = relations(providerConnections, ({ one }) => ({
    organization: one(projects, { fields: [providerConnections.organizationId], references: [projects.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// COMPANIES
// ═══════════════════════════════════════════════════════════════════════════════
export const companies = pgTable('companies', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    name: varchar('name', { length: 255 }).notNull(),
    domain: varchar('domain', { length: 255 }),
    website: text('website'),
    industry: varchar('industry', { length: 100 }),
    employeeCount: integer('employee_count'),
    estimatedRevenue: numeric('estimated_revenue', { precision: 12, scale: 2 }),
    address: jsonb('address'),
    linkedinUrl: text('linkedin_url'),
    metadata: jsonb('metadata').$type().notNull().default({}),
    source: text('source'), // apollo | linkedin | manual | enrichment
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('companies_organization_id_idx').on(table.organizationId),
    domainIdx: index('companies_domain_idx').on(table.domain),
    nameIdx: index('companies_name_idx').on(table.name),
    industryIdx: index('companies_industry_idx').on(table.industry),
}));
export const companyRelations = relations(companies, ({ one, many }) => ({
    organization: one(projects, { fields: [companies.organizationId], references: [projects.id] }),
    contacts: many(contacts),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// CONTACTS (refactored from researchedLeads where applicable)
// ═══════════════════════════════════════════════════════════════════════════════
// Note: researchedLeads remains for backward compatibility during migration.
// New revenue operations code uses contacts.
export const contacts = pgTable('contacts', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    companyId: uuid('company_id'), // companies.id
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    title: varchar('title', { length: 200 }),
    email: varchar('email', { length: 255 }),
    phoneE164: varchar('phone_e164', { length: 20 }),
    phoneType: text('phone_type'), // mobile | landline | voip | unknown
    timezone: varchar('timezone', { length: 50 }),
    location: jsonb('location'),
    source: text('source'), // research | import | enrichment | manual
    status: text('status').notNull().default('active'), // active | suppressed | archived
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('contacts_organization_id_idx').on(table.organizationId),
    companyIdIdx: index('contacts_company_id_idx').on(table.companyId),
    emailPartialUnique: uniqueIndex('contacts_email_unique')
        .on(table.organizationId, table.email)
        .where(sql `${table.email} IS NOT NULL`),
    phonePartialUnique: uniqueIndex('contacts_phone_unique')
        .on(table.organizationId, table.phoneE164)
        .where(sql `${table.phoneE164} IS NOT NULL`),
}));
export const contactRelations = relations(contacts, ({ one }) => ({
    organization: one(projects, { fields: [contacts.organizationId], references: [projects.id] }),
    company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// CONSENT RECORDS
// ═══════════════════════════════════════════════════════════════════════════════
export const consentRecords = pgTable('consent_records', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    contactId: uuid('contact_id').notNull(), // contacts.id
    channel: text('channel').notNull(), // phone | sms | email
    status: text('status').notNull().default('unknown'), // unknown | granted | denied | revoked
    consentType: text('consent_type'), // explicit | implied | transactional
    scope: text('scope'), // marketing | sales | support
    source: text('source'), // web_form | phone | email | manual
    evidence: jsonb('evidence'), // form submission id, timestamp, ip, etc.
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgContactChannelUnique: uniqueIndex('consent_records_org_contact_channel_unique')
        .on(table.organizationId, table.contactId, table.channel),
    statusIdx: index('consent_records_status_idx').on(table.status),
}));
export const consentRelations = relations(consentRecords, ({ one }) => ({
    organization: one(projects, { fields: [consentRecords.organizationId], references: [projects.id] }),
    contact: one(contacts, { fields: [consentRecords.contactId], references: [contacts.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// SUPPRESSIONS (cross-channel DNC)
// ═══════════════════════════════════════════════════════════════════════════════
// Supersedes emailSuppressions for cross-channel suppression.
export const suppressions = pgTable('suppressions', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    contactId: uuid('contact_id'), // contacts.id (nullable for email/phone-only suppressions)
    email: varchar('email', { length: 255 }),
    phoneE164: varchar('phone_e164', { length: 20 }),
    channel: text('channel').notNull(), // phone | sms | email | all
    reason: text('reason').notNull(), // opt_out | dnc | bounced | complaint | manual | legal
    source: text('source'), // webhook | manual | automated
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (table) => ({
    orgChannelUnique: uniqueIndex('suppressions_org_channel_unique')
        .on(table.organizationId, table.channel)
        .where(sql `${table.contactId} IS NULL AND ${table.email} IS NULL AND ${table.phoneE164} IS NULL`),
    contactIdIdx: index('suppressions_contact_id_idx').on(table.contactId),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// CAMPAIGNS (refactored from leadCampaigns/emailCampaigns pattern)
// ═══════════════════════════════════════════════════════════════════════════════
// Note: leadCampaigns and emailCampaigns remain for backward compatibility.
// New revenue operations uses campaigns with sequences.
export const campaigns = pgTable('campaigns', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    missionId: text('mission_id'), // goals.id (D1: mission = goal)
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'), // draft | validating | ready | active | paused | completed | cancelled
    audienceFilter: jsonb('audience_filter').$type(),
    dailyLimits: jsonb('daily_limits').$type().notNull().default({}),
    settings: jsonb('settings').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
    orgIdIdx: index('campaigns_organization_id_idx').on(table.organizationId),
    missionIdIdx: index('campaigns_mission_id_idx').on(table.missionId),
    statusIdx: index('campaigns_status_idx').on(table.status),
}));
export const campaignRelations = relations(campaigns, ({ one, many }) => ({
    organization: one(projects, { fields: [campaigns.organizationId], references: [projects.id] }),
    mission: one(goals, { fields: [campaigns.missionId], references: [goals.id] }),
    sequences: many(sequences),
    enrollments: many(campaignEnrollments),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// SEQUENCES
// ═══════════════════════════════════════════════════════════════════════════════
export const sequences = pgTable('sequences', {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull(), // campaigns.id
    name: varchar('name', { length: 200 }).notNull(),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('draft'), // draft | active | paused | completed
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    campaignIdIdx: index('sequences_campaign_id_idx').on(table.campaignId),
}));
export const sequenceRelations = relations(sequences, ({ one, many }) => ({
    campaign: one(campaigns, { fields: [sequences.campaignId], references: [campaigns.id] }),
    steps: many(sequenceSteps),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// SEQUENCE STEPS
// ═══════════════════════════════════════════════════════════════════════════════
export const sequenceSteps = pgTable('sequence_steps', {
    id: uuid('id').primaryKey().defaultRandom(),
    sequenceId: uuid('sequence_id').notNull(), // sequences.id
    position: integer('position').notNull(),
    channel: text('channel').notNull(), // email | phone | sms | task
    delaySeconds: integer('delay_seconds').notNull().default(0),
    condition: jsonb('condition'), // json logic for when this step applies
    templateId: uuid('template_id'), // reference to email/sms template
    configuration: jsonb('configuration').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    sequenceIdIdx: index('sequence_steps_sequence_id_idx').on(table.sequenceId),
    sequencePositionUnique: uniqueIndex('sequence_steps_sequence_position_unique')
        .on(table.sequenceId, table.position),
}));
export const sequenceStepRelations = relations(sequenceSteps, ({ one }) => ({
    sequence: one(sequences, { fields: [sequenceSteps.sequenceId], references: [sequences.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// CAMPAIGN ENROLLMENTS
// ═══════════════════════════════════════════════════════════════════════════════
export const campaignEnrollments = pgTable('campaign_enrollments', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    campaignId: uuid('campaign_id').notNull(), // campaigns.id
    contactId: uuid('contact_id').notNull(), // contacts.id
    status: text('status').notNull().default('pending'), // pending | active | waiting | responded | qualified | booked | suppressed | disqualified | completed | failed
    currentStepId: uuid('current_step_id'), // sequence_steps.id
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    stopReason: text('stop_reason'),
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgCampaignContactUnique: uniqueIndex('campaign_enrollments_org_campaign_contact_unique')
        .on(table.organizationId, table.campaignId, table.contactId),
    campaignIdIdx: index('campaign_enrollments_campaign_id_idx').on(table.campaignId),
    contactIdIdx: index('campaign_enrollments_contact_id_idx').on(table.contactId),
    statusIdx: index('campaign_enrollments_status_idx').on(table.status),
}));
export const campaignEnrollmentRelations = relations(campaignEnrollments, ({ one }) => ({
    organization: one(projects, { fields: [campaignEnrollments.organizationId], references: [projects.id] }),
    campaign: one(campaigns, { fields: [campaignEnrollments.campaignId], references: [campaigns.id] }),
    contact: one(contacts, { fields: [campaignEnrollments.contactId], references: [contacts.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTIONS (unified timeline - supersedes scattered logs/sms/email records)
// ═══════════════════════════════════════════════════════════════════════════════
// Note: Existing logs, smsMessages, emailSends remain for backward compatibility.
// New interactions are written to this table for Lead 360 timeline.
export const interactions = pgTable('interactions', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    missionId: text('mission_id'), // goals.id
    campaignId: uuid('campaign_id'), // campaigns.id
    contactId: uuid('contact_id'), // contacts.id
    companyId: uuid('company_id'), // companies.id
    channel: text('channel').notNull(), // phone | sms | email | calendar | web | internal
    direction: text('direction').notNull(), // inbound | outbound | internal
    type: text('type'), // call | email | sms | meeting | note | voicemail | callback
    provider: text('provider'), // telnyx | resend | google | manual
    externalId: text('external_id'), // provider's id for this interaction
    status: text('status'), // queued | sent | delivered | answered | completed | failed | responded
    subject: varchar('subject', { length: 500 }),
    bodySummary: text('body_summary'), // AI-generated summary, not full content
    structuredOutcome: jsonb('structured_outcome'), // AI-classified outcome (interested, not_interested, etc.)
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('interactions_organization_id_idx').on(table.organizationId),
    missionIdIdx: index('interactions_mission_id_idx').on(table.missionId),
    campaignIdIdx: index('interactions_campaign_id_idx').on(table.campaignId),
    contactIdIdx: index('interactions_contact_id_idx').on(table.contactId),
    channelDirectionIdx: index('interactions_channel_direction_idx').on(table.channel, table.direction),
    occurredAtIdx: index('interactions_occurred_at_idx').on(table.occurredAt),
}));
export const interactionRelations = relations(interactions, ({ one }) => ({
    organization: one(projects, { fields: [interactions.organizationId], references: [projects.id] }),
    mission: one(goals, { fields: [interactions.missionId], references: [goals.id] }),
    campaign: one(campaigns, { fields: [interactions.campaignId], references: [campaigns.id] }),
    contact: one(contacts, { fields: [interactions.contactId], references: [contacts.id] }),
    company: one(companies, { fields: [interactions.companyId], references: [companies.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// CALLS (full call tracking - extends callBridgeSessions pattern)
// ═══════════════════════════════════════════════════════════════════════════════
// Note: callBridgeSessions remains for operator-bridged calls. This table is for
// outbound AI calls from campaigns.
export const calls = pgTable('calls', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    missionId: text('mission_id'), // goals.id
    campaignId: uuid('campaign_id'), // campaigns.id
    contactId: uuid('contact_id'), // contacts.id
    providerConnectionId: uuid('provider_connection_id'), // provider_connections.id
    externalCallId: text('external_call_id'), // Telnyx/Vapi call id
    callControlId: text('call_control_id'), // Telnyx call_control_id
    callSessionId: text('call_session_id'), // voice AI session id
    fromNumber: varchar('from_number', { length: 20 }),
    toNumber: varchar('to_number', { length: 20 }),
    direction: text('direction').notNull(), // inbound | outbound
    status: text('status').notNull().default('requested'), // requested | queued | initiated | ringing | answered | bridged | completed | failed | cancelled
    disposition: text('disposition'), // human | voicemail | no_answer | busy | wrong_number | interested | not_interested | callback | qualified | booked | dnc | failed
    startedAt: timestamp('started_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    recordingUri: text('recording_uri'),
    transcriptId: uuid('transcript_id'),
    aiProvider: text('ai_provider'), // deepgram | vapi | other
    costCents: integer('cost_cents'),
    errorCode: text('error_code'),
    errorDetail: jsonb('error_detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('calls_organization_id_idx').on(table.organizationId),
    missionIdIdx: index('calls_mission_id_idx').on(table.missionId),
    campaignIdIdx: index('calls_campaign_id_idx').on(table.campaignId),
    contactIdIdx: index('calls_contact_id_idx').on(table.contactId),
    statusIdx: index('calls_status_idx').on(table.status),
    dispositionIdx: index('calls_disposition_idx').on(table.disposition),
    externalCallIdUnique: uniqueIndex('calls_external_call_id_unique').on(table.externalCallId)
        .where(sql `${table.externalCallId} IS NOT NULL`),
}));
export const callRelations = relations(calls, ({ one }) => ({
    organization: one(projects, { fields: [calls.organizationId], references: [projects.id] }),
    mission: one(goals, { fields: [calls.missionId], references: [goals.id] }),
    campaign: one(campaigns, { fields: [calls.campaignId], references: [campaigns.id] }),
    contact: one(contacts, { fields: [calls.contactId], references: [contacts.id] }),
    providerConnection: one(providerConnections, { fields: [calls.providerConnectionId], references: [providerConnections.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER EVENTS (idempotent webhook ingestion - Section 14 of spec)
// ═══════════════════════════════════════════════════════════════════════════════
export const providerEvents = pgTable('provider_events', {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(), // telnyx | resend | google | etc.
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: text('status').notNull().default('received'), // received | processed | ignored | failed
    attemptCount: integer('attempt_count').notNull().default(1),
    lastError: jsonb('last_error'),
}, (table) => ({
    providerEventIdUnique: uniqueIndex('provider_events_provider_event_id_unique')
        .on(table.provider, table.externalEventId),
    statusIdx: index('provider_events_status_idx').on(table.status),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════════════════════════════
export const calendarConnections = pgTable('calendar_connections', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    provider: text('provider').notNull(), // google | microsoft
    externalAccountId: text('external_account_id'),
    encryptedCredentials: jsonb('encrypted_credentials').$type().notNull(),
    status: text('status').notNull().default('connected'), // connected | degraded | disconnected
    configuration: jsonb('configuration').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('calendar_connections_organization_id_idx').on(table.organizationId),
}));
export const meetings = pgTable('meetings', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    missionId: text('mission_id'), // goals.id
    contactId: uuid('contact_id'), // contacts.id
    provider: text('provider'), // google | microsoft | manual
    externalEventId: text('external_event_id'),
    title: varchar('title', { length: 500 }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('proposed'), // proposed | scheduled | completed | cancelled | no_show
    meetingUrl: text('meeting_url'),
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('meetings_organization_id_idx').on(table.organizationId),
    contactIdIdx: index('meetings_contact_id_idx').on(table.contactId),
    statusIdx: index('meetings_status_idx').on(table.status),
}));
export const meetingAttendees = pgTable('meeting_attendees', {
    id: uuid('id').primaryKey().defaultRandom(),
    meetingId: uuid('meeting_id').notNull(), // meetings.id
    contactId: uuid('contact_id').notNull(), // contacts.id
    role: text('role').notNull().default('attendee'), // attendee | organizer
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    meetingIdIdx: index('meeting_attendees_meeting_id_idx').on(table.meetingId),
    meetingContactUnique: uniqueIndex('meeting_attendees_meeting_contact_unique')
        .on(table.meetingId, table.contactId),
}));
export const availabilityRules = pgTable('availability_rules', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    contactId: uuid('contact_id'), // contacts.id (nullable for org-level rules)
    rule: jsonb('rule').$type().notNull(), // day-of-week, time ranges, etc.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('availability_rules_organization_id_idx').on(table.organizationId),
    contactIdIdx: index('availability_rules_contact_id_idx').on(table.contactId),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
export const pipelineStages = pgTable('pipeline_stages', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    name: varchar('name', { length: 100 }).notNull(),
    position: integer('position').notNull(),
    type: text('type'), // lead | opportunity | closing
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('pipeline_stages_organization_id_idx').on(table.organizationId),
    orgPositionUnique: uniqueIndex('pipeline_stages_org_position_unique')
        .on(table.organizationId, table.position),
}));
export const salesOpportunities = pgTable('sales_opportunities', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    contactId: uuid('contact_id'), // contacts.id
    companyId: uuid('company_id'), // companies.id
    missionId: text('mission_id'), // goals.id
    stageId: uuid('stage_id'), // pipeline_stages.id
    name: varchar('name', { length: 500 }).notNull(),
    amountCents: numeric('amount_cents', { precision: 12, scale: 2 }),
    probability: real('probability'), // 0.0 - 1.0, model-generated if from AI
    probabilitySource: text('probability_source'), // model_generated | manual | rule_based
    source: text('source'), // campaign | referral | inbound | outbound | manual
    ownerUserId: text('owner_user_id'), // users.id (if user system exists)
    status: text('status').notNull().default('open'), // open | qualified | proposed | negotiated | won | lost | stalled
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    notes: text('notes'),
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('sales_opportunities_organization_id_idx').on(table.organizationId),
    contactIdIdx: index('sales_opportunities_contact_id_idx').on(table.contactId),
    companyIdIdx: index('sales_opportunities_company_id_idx').on(table.companyId),
    stageIdIdx: index('sales_opportunities_stage_id_idx').on(table.stageId),
    missionIdIdx: index('sales_opportunities_mission_id_idx').on(table.missionId),
    statusIdx: index('sales_opportunities_status_idx').on(table.status),
}));
export const salesOpportunityRelations = relations(salesOpportunities, ({ one }) => ({
    organization: one(projects, { fields: [salesOpportunities.organizationId], references: [projects.id] }),
    contact: one(contacts, { fields: [salesOpportunities.contactId], references: [contacts.id] }),
    company: one(companies, { fields: [salesOpportunities.companyId], references: [companies.id] }),
    mission: one(goals, { fields: [salesOpportunities.missionId], references: [goals.id] }),
    stage: one(pipelineStages, { fields: [salesOpportunities.stageId], references: [pipelineStages.id] }),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE (RAG - Section 22 of spec)
// ═══════════════════════════════════════════════════════════════════════════════
export const knowledgeSources = pgTable('knowledge_sources', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    type: text('type').notNull(), // document | url | database | api
    name: varchar('name', { length: 200 }).notNull(),
    uri: text('uri'),
    status: text('status').notNull().default('active'), // active | syncing | error | disabled
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('knowledge_sources_organization_id_idx').on(table.organizationId),
    typeIdx: index('knowledge_sources_type_idx').on(table.type),
}));
export const knowledgeDocuments = pgTable('knowledge_documents', {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id').notNull(), // knowledge_sources.id
    contentHash: varchar('content_hash', { length: 64 }), // sha256
    title: varchar('title', { length: 500 }),
    text: text('text'), // extracted text content
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    sourceIdIdx: index('knowledge_documents_source_id_idx').on(table.sourceId),
    contentHashIdx: index('knowledge_documents_content_hash_idx').on(table.contentHash),
}));
export const knowledgeChunks = pgTable('knowledge_chunks', {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').notNull(), // knowledge_documents.id
    text: text('text').notNull(),
    embedding: jsonb('embedding').$type(), // vector embedding (stored as array)
    metadata: jsonb('metadata').$type().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    documentIdIdx: index('knowledge_chunks_document_id_idx').on(table.documentId),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// USAGE LEDGER (Section 19 of spec - unified spend tracking)
// ═══════════════════════════════════════════════════════════════════════════════
// Supersedes/supplements llmSpendDaily for non-LLM spend (voice, sms, etc.)
export const usageLedger = pgTable('usage_ledger', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    missionId: text('mission_id'), // goals.id
    taskId: text('task_id'), // tasks.id
    provider: text('provider').notNull(), // openrouter | telnyx | resend | deepgram | vapi
    category: text('category').notNull(), // ai | voice | sms | email | data | enrichment | other
    quantity: numeric('quantity', { precision: 12, scale: 4 }),
    unit: text('unit'), // requests | minutes | messages | rows | etc.
    amountCents: integer('amount_cents').notNull().default(0),
    externalReference: text('external_reference'), // provider's invoice/reference id
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('usage_ledger_organization_id_idx').on(table.organizationId),
    missionIdIdx: index('usage_ledger_mission_id_idx').on(table.missionId),
    providerIdx: index('usage_ledger_provider_idx').on(table.provider),
    categoryIdx: index('usage_ledger_category_idx').on(table.category),
    createdAtIndex: index('usage_ledger_created_at_idx').on(table.createdAt),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT EVENTS (Section 38 of spec)
// ═══════════════════════════════════════════════════════════════════════════════
export const auditEvents = pgTable('audit_events', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    actorType: text('actor_type').notNull(), // user | agent | system | provider
    actorId: text('actor_id').notNull(), // id of the actor (agent id, user id, system name)
    action: text('action').notNull(), // campaign.started | call.initiated | contact.suppressed | etc.
    entityType: text('entity_type'), // campaign | contact | call | approval | opportunity
    entityId: text('entity_id'), // id of the entity (uuid or text)
    metadata: jsonb('metadata').$type(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('audit_events_organization_id_idx').on(table.organizationId),
    actorTypeIdx: index('audit_events_actor_type_idx').on(table.actorType),
    actionIdx: index('audit_events_action_idx').on(table.action),
    entityTypeIdx: index('audit_events_entity_type_idx').on(table.entityType),
    createdAtIdx: index('audit_events_created_at_idx').on(table.createdAt),
    entityUnique: uniqueIndex('audit_events_entity_unique')
        .on(table.entityType, table.entityId)
        .where(sql `${table.entityType} IS NOT NULL AND ${table.entityId} IS NOT NULL`),
}));
// ═══════════════════════════════════════════════════════════════════════════════
// COMPLIANCE & CAPTURE (Section 9 of spec)
// ═══════════════════════════════════════════════════════════════════════════════
// Consent-gated outreach and cross-channel suppression are covered by the
// consent_records + suppressions tables above. This section adds the
// operational safety layer: contact-level outreach gates, suppression
// propagation, and batch consent audit for TCPA/TCPR/GDPR evidence.
// ── Contact outreach gate (per-contact, per-channel allow/deny/no-decision) ─────
// Computed from consent_records on read; persisted for fast routing decisions.
// A contact is "outreach-safe" on a channel only when the gate is 'allowed'.
// 'denied' and 'pending' block outbound on that channel.
export const contactOutreachGates = pgTable('contact_outreach_gates', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    contactId: uuid('contact_id').notNull(), // contacts.id
    channel: text('channel').notNull(), // phone | sms | email
    gate: text('gate').notNull().default('pending'), // allowed | denied | pending
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    nextReviewAt: timestamp('next_review_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgContactChannelUnique: uniqueIndex('contact_outreach_gates_org_contact_channel_unique')
        .on(table.organizationId, table.contactId, table.channel),
    gateIdx: index('contact_outreach_gates_gate_idx').on(table.gate),
}));
export const contactOutreachGateRelations = relations(contactOutreachGates, ({ one }) => ({
    organization: one(projects, { fields: [contactOutreachGates.organizationId], references: [projects.id] }),
    contact: one(contacts, { fields: [contactOutreachGates.contactId], references: [contacts.id] }),
}));
// ── Suppression propagation audit ────────────────────────────────────────────────
// When a contact opts out on one channel, this records the propagation decision
// to other channels (e.g. phone opt-out → suppress sms on same number).
export const suppressionPropagation = pgTable('suppression_propagation', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    sourceSuppressionId: uuid('source_suppression_id').notNull(), // suppressions.id
    targetChannel: text('target_channel').notNull(), // channel being suppressed
    targetIdentifier: text('target_identifier'), // email/phone affected
    action: text('action').notNull(), // suppress | lift | skip
    reason: text('reason'), // derived from source reason
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    sourceIdx: index('suppression_propagation_source_suppression_id_idx').on(table.sourceSuppressionId),
}));
// ── Batch consent audit (TCPA/TCPR evidence) ─────────────────────────────────────
// Immutable records of consent-audit snapshots for regulatory evidence.
// One row per audit run; details in metadata.
export const consentAuditSnapshots = pgTable('consent_audit_snapshots', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    scope: text('scope').notNull(), // all | campaign | contact_list | manual
    scopeRef: text('scope_ref'), // campaign id or contact list id being audited
    status: text('status').notNull().default('running'), // running | completed | failed
    contactsReviewed: integer('contacts_reviewed').notNull().default(0),
    contactsCompliant: integer('contacts_compliant').notNull().default(0),
    contactsNonCompliant: integer('contacts_non_compliant').notNull().default(0),
    findings: jsonb('findings').$type(), // per-channel counts, violations
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgIdIdx: index('consent_audit_snapshots_organization_id_idx').on(table.organizationId),
    scopeIdx: index('consent_audit_snapshots_scope_idx').on(table.scope),
    statusIdx: index('consent_audit_snapshots_status_idx').on(table.status),
}));
export const complianceTypeExports = {
    ContactOutreachGate: typeof contactOutreachGates.$inferSelect,
    NewContactOutreachGate: typeof contactOutreachGates.$inferInsert,
    SuppressionPropagation: typeof suppressionPropagation.$inferSelect,
    NewSuppressionPropagation: typeof suppressionPropagation.$inferInsert,
    ConsentAuditSnapshot: typeof consentAuditSnapshots.$inferSelect,
    NewConsentAuditSnapshot: typeof consentAuditSnapshots.$inferInsert,
};
// ── Mission step / task-run (Section 7.4) ─────────────────────────────────────────
// Each mission step is backed by an APEX task with mission_step_id in task.result.
// This table is the metadata layer — the execution is an APEX task.
export const missionSteps = pgTable('mission_steps', {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(), // projects.id
    missionId: text('mission_id').notNull(), // goals.id
    position: integer('position').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    channel: text('channel'), // call | sms | email | task | webhook
    status: text('status').notNull().default('pending'), // pending | ready | in_progress | done | failed | skipped | blocked
    taskId: text('task_id'), // tasks.id when the step is backed by an APEX task
    outcome: jsonb('outcome').$type(), // result of the step execution
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    orgMissionIdx: index('mission_steps_organization_id_idx').on(table.organizationId),
    missionIdIdx: index('mission_steps_mission_id_idx').on(table.missionId),
    positionIdx: index('mission_steps_position_idx').on(table.position),
    statusIdx: index('mission_steps_status_idx').on(table.status),
}));
export const missionStepRelations = relations(missionSteps, ({ one }) => ({
    organization: one(projects, { fields: [missionSteps.organizationId], references: [projects.id] }),
    mission: one(goals, { fields: [missionSteps.missionId], references: [goals.id] }),
}));
