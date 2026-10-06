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

import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  boolean,
  uuid,
  uniqueIndex,
  index,
  primaryKey,
  varchar,
  numeric,
  customType,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/** Postgres tsvector. Maintained by triggers in the CRM migration, not by app updates. */
export const tsvector = customType<{ data: string }>({\n  dataType() {\n    return 'tsvector';\n  },\n});\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
  encryptedCredentials: jsonb('encrypted_credentials').$type<Record<string, unknown>>().notNull(),
  externalAccountId: text('external_account_id'),
  status: text('status').notNull().default('connected'), // connected | degraded | disconnected | error
  configuration: jsonb('configuration').$type<Record<string, unknown>>().notNull().default({}),
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  lastError: jsonb('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({\n  orgProviderTypeUnique: uniqueIndex('provider_connections_org_provider_type_unique')
    .on(table.organizationId, table.provider, table.type),
  statusIdx: index('provider_connections_status_idx').on(table.status),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  source: text('source'), // apollo | linkedin | manual | enrichment
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({\n  orgIdIdx: index('companies_organization_id_idx').on(table.organizationId),
  domainIdx: index('companies_domain_idx').on(table.domain),
  nameIdx: index('companies_name_idx').on(table.name),
  industryIdx: index('companies_industry_idx').on(table.industry),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
  /** Display organization when the contact is not linked to a companies row (newsrooms, outlets). */
  organizationName: text('organization_name'),
  website: text('website'),
  socialHandles: jsonb('social_handles').$type<Record<string, string>>().notNull().default({}),
  city: varchar('city', { length: 120 }),
  state: varchar('state', { length: 80 }),
  tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
  notes: text('notes'),
  ownerBot: text('owner_bot'),
  doNotContact: boolean('do_not_contact').notNull().default(false),
  doNotContactReason: text('do_not_contact_reason'),
  doNotContactSetBy: text('do_not_contact_set_by'),
  doNotContactSetAt: timestamp('do_not_contact_set_at', { withTimezone: true }),
  lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
  lastReplyAt: timestamp('last_reply_at', { withTimezone: true }),
  nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
  followUpPaused: boolean('follow_up_paused').notNull().default(false),
  /** Maintained by crm_contacts_search_vector_refresh. Do not write from application code. */
  searchVector: tsvector('search_vector'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({\n  orgIdIdx: index('contacts_organization_id_idx').on(table.organizationId),
  companyIdIdx: index('contacts_company_id_idx').on(table.companyId),
  emailPartialUnique: uniqueIndex('contacts_email_unique')
    .on(table.organizationId, table.email)
    .where(sql`${table.email} IS NOT NULL`),
  phonePartialUnique: uniqueIndex('contacts_phone_unique')
    .on(table.organizationId, table.phoneE164)
    .where(sql`${table.phoneE164} IS NOT NULL`),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
}, (table) => ({\n  orgContactChannelUnique: uniqueIndex('consent_records_org_contact_channel_unique')
    .on(table.organizationId, table.contactId, table.channel),
  statusIdx: index('consent_records_status_idx').on(table.status),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
}, (table) => ({\n  orgChannelUnique: uniqueIndex('suppressions_org_channel_unique')
    .on(table.organizationId, table.channel)
    .where(sql`${table.contactId} IS NULL AND ${table.email} IS NULL AND ${table.phoneE164} IS NULL`),
  contactIdIdx: index('suppressions_contact_id_idx').on(table.contactId),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
  audienceFilter: jsonb('audience_filter').$type<Record<string, unknown>>(),
  dailyLimits: jsonb('daily_limits').$type<Record<string, unknown>>().notNull().default({}),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({\n  orgIdIdx: index('campaigns_organization_id_idx').on(table.organizationId),
  missionIdIdx: index('campaigns_mission_id_idx').on(table.missionId),
  statusIdx: index('campaigns_status_idx').on(table.status),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
}, (table) => ({\n  campaignIdIdx: index('sequences_campaign_id_idx').on(table.campaignId),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
  configuration: jsonb('configuration').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({\n  sequenceIdIdx: index('sequence_steps_sequence_id_idx').on(table.sequenceId),
  sequencePositionUnique: uniqueIndex('sequence_steps_sequence_position_unique')
    .on(table.sequenceId, table.position),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
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
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({\n  orgCampaignContactUnique: uniqueIndex('campaign_enrollments_org_campaign_contact_unique')
    .on(table.organizationId, table.campaignId, table.contactId),
  campaignIdIdx: index('campaign_enrollments_campaign_id_idx').on(table.campaignId),
  contactIdIdx: index('campaign_enrollments_contact_id_idx').on(table.contactId),
  statusIdx: index('campaign_enrollments_status_idx').on(table.status),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
// OUTREACH STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════════
// One durable, auditable strategy per prospect and campaign. This is the
// bridge between qualification and execution: every touch can use the same
// approved pain hypothesis, value proposition, and personalization facts.

export const outreachStrategies = pgTable('outreach_strategies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  campaignId: uuid('campaign_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  enrollmentId: uuid('enrollment_id'),
  version: integer('version').notNull().default(1),
  status: text('status').notNull().default('ready'), // draft | ready | active | retired
  objective: text('objective').notNull(),
  painHypothesis: text('pain_hypothesis').notNull(),
  valueProposition: text('value_proposition').notNull(),
  openingAngle: text('opening_angle').notNull(),
  channelOrder: jsonb('channel_order').$type<string[]>().notNull().default([]),
  personalization: jsonb('personalization').$type<Record<string, unknown>>().notNull().default({}),
  qualificationCriteria: jsonb('qualification_criteria').$type<string[]>().notNull().default([]),
  nextBestAction: text('next_best_action').notNull(),
  confidence: real('confidence').notNull().default(0.5),
  source: text('source').notNull().default('deterministic'), // deterministic | llm | human
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({\n  orgCampaignContactUnique: uniqueIndex('outreach_strategies_org_campaign_contact_unique')
    .on(table.organizationId, table.campaignId, table.contactId),
  contactIdx: index('outreach_strategies_contact_id_idx').on(table.contactId),
  campaignIdx: index('outreach_strategies_campaign_id_idx').on(table.campaignId),
  statusIdx: index('outreach_strategies_status_idx').on(table.status),
}));\n\n// ═══════════════════════════════════════════════════════════════════════════════
// SEQUENCE STEP EXECUTIONS
// ═══════════════════════════════════════════════════════════════════════════════
// Durable idempotency ledger for the workforce loop. Enrollment metadata is
// useful context, but it cannot safely answer \"did this exact step run?\" when
// two workers race or a process dies between the provider call and the update.

export const sequenceStepExecutions = pgTable('sequence_step_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  enrollmentId: uuid('enrollment_id').notNull(),
  stepId: uuid('step_id').notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
  status: text('status').notNull().default('queued'), // queued | running | awaiting_approval | succeeded | failed | skipped
  attemptCount: integer('attempt_count').notNull().default(0),
  interactionId: uuid('interaction_id'),
  result: jsonb('result'),
}, (table) => ({\n  orgEnrollmentStepUnique: uniqueIndex('sequence_step_executions_org_enrollment_step_unique')
    .on(table.organizationId, table.enrollmentId, table.stepId),
  enrollmentIdIdx: index('sequence_step_executions_enrollment_id_idx').on(table.enrollmentId),
  statusIdx: index('sequence_step_executions_status_idx').on(table.status),
}));

