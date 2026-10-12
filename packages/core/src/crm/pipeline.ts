/**
 * CRM phase 2: the pipeline, and the company behind a deal.
 *
 * The board is the existing pipeline_stages + sales_opportunities pair, which
 * until now had no screen and no API. A deal carries a value, an expected close
 * date, a next step, and a won/lost outcome; closing one as won moves its
 * contact to client, which is the same operator-gated status the contact book
 * uses (see operator.ts).
 *
 * Nothing here is reachable from an agent: the deal writes are not imported by
 * tools.ts, and the privileges that matter (closing a deal, and the client
 * status that follows) are checked at the write path.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditEvents,
  companies,
  contactTimeline,
  contacts,
  crmTasks,
  db,
  pipelineStages,
  salesOpportunities,
} from '@workspace/db';
import { CRM_ORGANIZATION_ID, OPERATOR_ACTOR, lifecycleStageChangeAllowed } from './pure.js';
import { asExecutor, insertTimelineEvent, type CrmDb } from './store.js';
import { CrmWriteError } from './operator.js';

export const DEAL_STATUSES = ['open', 'qualified', 'proposed', 'negotiated', 'won', 'lost', 'stalled'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

/** A deal is live until it is won or lost. Everything else is in flight. */
export function isOpenDealStatus(status: string): boolean {
  return status !== 'won' && status !== 'lost';
}

export const DEFAULT_PIPELINE_STAGES = [
  { name: 'Qualified', position: 1 },
  { name: 'Proposal sent', position: 2 },
  { name: 'Negotiation', position: 3 },
  { name: 'Verbal yes', position: 4 },
] as const;

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanLimited(value: unknown, max: number): string | null {
  const trimmed = clean(value);
  return trimmed ? trimmed.slice(0, max) : null;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Amounts are stored in cents. A blank or unparseable value is no value. */
export function parseAmountCents(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const asNumber = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : Number(value);
  if (!Number.isFinite(asNumber) || asNumber < 0) return null;
  if (asNumber > 1_000_000_000) return null;
  return asNumber.toFixed(2);
}

function amountToNumber(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function audit(
  executor: CrmDb,
  input: { actor: string; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await executor.insert(auditEvents).values({
    organizationId: CRM_ORGANIZATION_ID,
    actorType: input.actor === OPERATOR_ACTOR ? 'user' : 'system',
    actorId: input.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata ?? {},
  });
}

/** The stages, seeding the defaults the first time anyone asks. */
export async function listPipelineStages() {
  const existing = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.organizationId, CRM_ORGANIZATION_ID))
    .orderBy(asc(pipelineStages.position));
  if (existing.length > 0) return existing;
  for (const stage of DEFAULT_PIPELINE_STAGES) {
    await db
      .insert(pipelineStages)
      .values({
        organizationId: CRM_ORGANIZATION_ID,
        name: stage.name,
        position: stage.position,
        type: 'opportunity',
        metadata: { seeded: 'crm_pipeline' },
      })
      .onConflictDoNothing();
  }
  return db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.organizationId, CRM_ORGANIZATION_ID))
    .orderBy(asc(pipelineStages.position));
}

export interface DealRow {
  id: string;
  name: string;
  status: string;
  amountCents: string | null;
  amountUsd: number;
  probability: number | null;
  expectedCloseAt: Date | null;
  closedAt: Date | null;
  nextStep: string | null;
  lostReason: string | null;
  wonReason: string | null;
  notes: string | null;
  stageId: string | null;
  stageName: string | null;
  stagePosition: number | null;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDealRow(row: {
  deal: typeof salesOpportunities.$inferSelect;
  stageName: string | null;
  stagePosition: number | null;
  contactFirst: string | null;
  contactLast: string | null;
  contactOrg: string | null;
  companyName: string | null;
}): DealRow {
  const person = [row.contactFirst, row.contactLast].filter(Boolean).join(' ');
  return {
    id: row.deal.id,
    name: row.deal.name,
    status: row.deal.status,
    amountCents: row.deal.amountCents,
    amountUsd: amountToNumber(row.deal.amountCents),
    probability: row.deal.probability,
    expectedCloseAt: row.deal.expectedCloseAt,
    closedAt: row.deal.closedAt,
    nextStep: row.deal.nextStep,
    lostReason: row.deal.lostReason,
    wonReason: row.deal.wonReason,
    notes: row.deal.notes,
    stageId: row.deal.stageId,
    stageName: row.stageName,
    stagePosition: row.stagePosition,
    contactId: row.deal.contactId,
    contactName: person || row.contactOrg || null,
    companyId: row.deal.companyId,
    companyName: row.companyName,
    createdAt: row.deal.createdAt,
    updatedAt: row.deal.updatedAt,
  };
}

function dealSelect() {
  return db
    .select({
      deal: salesOpportunities,
      stageName: pipelineStages.name,
      stagePosition: pipelineStages.position,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
      contactOrg: contacts.organizationName,
      companyName: companies.name,
    })
    .from(salesOpportunities)
    .leftJoin(pipelineStages, eq(pipelineStages.id, salesOpportunities.stageId))
    .leftJoin(contacts, eq(contacts.id, salesOpportunities.contactId))
    .leftJoin(companies, eq(companies.id, salesOpportunities.companyId));
}

export interface PipelineBoard {
  stages: Array<{ id: string; name: string; position: number; deals: DealRow[]; totalUsd: number }>;
  /** Deals with no stage at all, which would otherwise be invisible. */
  unassigned: { deals: DealRow[]; totalUsd: number };
  open: { count: number; totalUsd: number; weightedUsd: number; closingThisMonthUsd: number };
  closed: { won: number; lost: number; wonUsd: number; lostUsd: number };
  asOf: Date;
}

/**
 * The board. Open deals sit in their stage column; the header figures cover the
 * same open set, with a weighted total (value × probability, or the value when
 * no probability is recorded) and what is expected to close this month.
 */
export async function pipelineBoard(): Promise<PipelineBoard> {
  const stages = await listPipelineStages();
  const rows = await dealSelect()
    .where(eq(salesOpportunities.organizationId, CRM_ORGANIZATION_ID))
    .orderBy(asc(salesOpportunities.expectedCloseAt), desc(salesOpportunities.updatedAt))
    .limit(1000);
  const deals = rows.map(toDealRow);

  const boardStages = stages.map((stage) => {
    const stageDeals = deals.filter((deal) => deal.stageId === stage.id && isOpenDealStatus(deal.status));
    return {
      id: stage.id,
      name: stage.name,
      position: stage.position,
      deals: stageDeals,
      totalUsd: stageDeals.reduce((sum, deal) => sum + deal.amountUsd, 0),
    };
  });

  const unassignedDeals = deals.filter((deal) => !deal.stageId && isOpenDealStatus(deal.status));
  const openDeals = deals.filter((deal) => isOpenDealStatus(deal.status));
  const won = deals.filter((deal) => deal.status === 'won');
  const lost = deals.filter((deal) => deal.status === 'lost');
  const now = new Date();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return {
    stages: boardStages,
    unassigned: {
      deals: unassignedDeals,
      totalUsd: unassignedDeals.reduce((sum, deal) => sum + deal.amountUsd, 0),
    },
    open: {
      count: openDeals.length,
      totalUsd: openDeals.reduce((sum, deal) => sum + deal.amountUsd, 0),
      weightedUsd: openDeals.reduce(
        (sum, deal) => sum + deal.amountUsd * (deal.probability === null ? 1 : deal.probability),
        0,
      ),
      closingThisMonthUsd: openDeals
        .filter((deal) => deal.expectedCloseAt && deal.expectedCloseAt < monthEnd)
        .reduce((sum, deal) => sum + deal.amountUsd, 0),
    },
    closed: {
      won: won.length,
      lost: lost.length,
      wonUsd: won.reduce((sum, deal) => sum + deal.amountUsd, 0),
      lostUsd: lost.reduce((sum, deal) => sum + deal.amountUsd, 0),
    },
    asOf: now,
  };
}

export async function listDeals(input: { contactId?: string | null; companyId?: string | null; limit?: number } = {}): Promise<DealRow[]> {
  const clauses = [eq(salesOpportunities.organizationId, CRM_ORGANIZATION_ID)];
  if (input.contactId) clauses.push(eq(salesOpportunities.contactId, input.contactId));
  if (input.companyId) clauses.push(eq(salesOpportunities.companyId, input.companyId));
  const rows = await dealSelect()
    .where(and(...clauses))
    .orderBy(desc(salesOpportunities.updatedAt))
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 500));
  return rows.map(toDealRow);
}

async function resolveStageId(explicit: unknown, fallbackFirst = true): Promise<string | null> {
  const stageId = clean(explicit);
  if (stageId) {
    const [stage] = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.organizationId, CRM_ORGANIZATION_ID)))
      .limit(1);
    if (!stage) throw new CrmWriteError('That pipeline stage was not found.');
    return stage.id;
  }
  if (!fallbackFirst) return null;
  const [first] = await listPipelineStages();
  return first?.id ?? null;
}

export async function createDeal(input: {
  actor: string;
  name?: unknown;
  contactId?: unknown;
  companyId?: unknown;
  stageId?: unknown;
  amount?: unknown;
  probability?: unknown;
  expectedCloseAt?: unknown;
  nextStep?: unknown;
  notes?: unknown;
  status?: unknown;
  source?: unknown;
}): Promise<{ dealId: string }> {
  const name = cleanLimited(input.name, 500);
  if (!name) throw new CrmWriteError('A deal needs a name.');
  const contactId = clean(input.contactId);
  const companyId = clean(input.companyId);
  let contactName: string | null = null;
  if (contactId) {
    const [contact] = await db
      .select({ id: contacts.id, name: contacts.organizationName, first: contacts.firstName, last: contacts.lastName })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (!contact) throw new CrmWriteError('Contact not found');
    contactName = [contact.first, contact.last].filter(Boolean).join(' ') || contact.name;
  }
  if (companyId) {
    const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!company) throw new CrmWriteError('Company not found');
  }
  const statusInput = clean(input.status) ?? 'open';
  if (!(DEAL_STATUSES as readonly string[]).includes(statusInput)) {
    throw new CrmWriteError(`Unknown deal status "${statusInput}". Use one of ${DEAL_STATUSES.join(', ')}.`);
  }
  const probabilityInput = input.probability === null || input.probability === undefined || input.probability === ''
    ? null
    : Number(input.probability);
  if (probabilityInput !== null && (!Number.isFinite(probabilityInput) || probabilityInput < 0 || probabilityInput > 1)) {
    throw new CrmWriteError('Probability is a fraction between 0 and 1.');
  }
  const amountCents = parseAmountCents(input.amount);
  if (input.amount !== undefined && input.amount !== null && input.amount !== '' && amountCents === null) {
    throw new CrmWriteError('That deal value is not a usable amount.');
  }
  const stageId = await resolveStageId(input.stageId);
  const at = new Date();
  const dealId = await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const [created] = await executor.insert(salesOpportunities).values({
      organizationId: CRM_ORGANIZATION_ID,
      contactId,
      companyId,
      stageId,
      name,
      amountCents,
      probability: probabilityInput,
      probabilitySource: probabilityInput === null ? null : 'manual',
      source: cleanLimited(input.source, 60) ?? 'manual',
      status: statusInput,
      expectedCloseAt: parseDate(input.expectedCloseAt),
      nextStep: cleanLimited(input.nextStep, 300),
      notes: clean(input.notes),
      ownerUserId: input.actor,
    }).returning({ id: salesOpportunities.id });
    if (!created) throw new CrmWriteError('Deal insert returned no id');
    await audit(executor, {
      actor: input.actor,
      action: 'deal.created',
      entityType: 'sales_opportunity',
      entityId: created.id,
      metadata: { name, amountCents, stageId, contactId, companyId },
    });
    if (contactId) {
      await insertTimelineEvent(executor, {
        contactId,
        channel: 'internal',
        direction: 'internal',
        actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
        actorName: input.actor,
        eventKind: 'deal_created',
        bodyText: `Deal opened: ${name}${amountCents ? ` — $${amountToNumber(amountCents).toLocaleString('en-US')}` : ''}.`,
        provider: 'crm',
        providerMessageId: `deal-created:${created.id}`,
      });
    }
    return created.id;
  });
  return { dealId: dealId ?? '' };
}

export interface UpdateDealInput {
  dealId: string;
  actor: string;
  patch: Record<string, unknown>;
}

export async function updateDeal(input: UpdateDealInput): Promise<{ changed: string[] }> {
  const [existing] = await db.select().from(salesOpportunities).where(eq(salesOpportunities.id, input.dealId)).limit(1);
  if (!existing) throw new CrmWriteError('Deal not found');
  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const setIfChanged = (key: string, next: unknown, current: unknown) => {
    if ((current ?? null) === (next ?? null)) return;
    patch[key] = next;
    changed.push(key);
  };
  if ('name' in input.patch) setIfChanged('name', cleanLimited(input.patch.name, 500), existing.name);
  if ('amount' in input.patch) {
    const amountCents = parseAmountCents(input.patch.amount);
    if (input.patch.amount !== null && input.patch.amount !== '' && amountCents === null) {
      throw new CrmWriteError('That deal value is not a usable amount.');
    }
    setIfChanged('amountCents', amountCents, existing.amountCents);
  }
  if ('probability' in input.patch) {
    const raw = input.patch.probability;
    const probability = raw === null || raw === '' ? null : Number(raw);
    if (probability !== null && (!Number.isFinite(probability) || probability < 0 || probability > 1)) {
      throw new CrmWriteError('Probability is a fraction between 0 and 1.');
    }
    setIfChanged('probability', probability, existing.probability);
    if (!(patch.probability === undefined)) patch.probabilitySource = 'manual';
  }
  if ('expectedCloseAt' in input.patch) setIfChanged('expectedCloseAt', parseDate(input.patch.expectedCloseAt), existing.expectedCloseAt);
  if ('nextStep' in input.patch) setIfChanged('nextStep', cleanLimited(input.patch.nextStep, 300), existing.nextStep);
  if ('notes' in input.patch) setIfChanged('notes', clean(input.patch.notes), existing.notes);
  if ('contactId' in input.patch) {
    const contactId = clean(input.patch.contactId);
    if (contactId) {
      const [contact] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
      if (!contact) throw new CrmWriteError('Contact not found');
    }
    setIfChanged('contactId', contactId, existing.contactId);
  }
  if ('companyId' in input.patch) {
    const companyId = clean(input.patch.companyId);
    if (companyId) {
      const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
      if (!company) throw new CrmWriteError('Company not found');
    }
    setIfChanged('companyId', companyId, existing.companyId);
  }
  if ('stageId' in input.patch) {
    const stageId = await resolveStageId(input.patch.stageId, false);
    setIfChanged('stageId', stageId, existing.stageId);
  }
  if (changed.length === 0) throw new CrmWriteError('Nothing to change.');
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(salesOpportunities).set({ ...patch, updatedAt: at }).where(eq(salesOpportunities.id, input.dealId));
    await audit(executor, {
      actor: input.actor,
      action: 'deal.updated',
      entityType: 'sales_opportunity',
      entityId: input.dealId,
      metadata: { fields: changed },
    });
    if (existing.contactId) {
      await insertTimelineEvent(executor, {
        contactId: existing.contactId,
        channel: 'internal',
        direction: 'internal',
        actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
        actorName: input.actor,
        eventKind: 'deal_updated',
        bodyText: `Deal "${existing.name}" changed: ${changed.join(', ')}.`,
        provider: 'crm',
        providerMessageId: `deal-updated:${input.dealId}:${at.toISOString()}`,
      });
    }
  });
  return { changed };
}

/** Move a deal to another column. The move is logged on the contact's history. */
export async function moveDeal(input: { dealId: string; actor: string; stageId?: unknown }): Promise<{ from: string | null; to: string | null }> {
  const [existing] = await db.select().from(salesOpportunities).where(eq(salesOpportunities.id, input.dealId)).limit(1);
  if (!existing) throw new CrmWriteError('Deal not found');
  const stageId = await resolveStageId(input.stageId, false);
  if (!stageId) throw new CrmWriteError('A move needs a stage.');
  if (stageId === existing.stageId) return { from: existing.stageId, to: stageId };
  const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, stageId)).limit(1);
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(salesOpportunities).set({ stageId, updatedAt: at }).where(eq(salesOpportunities.id, input.dealId));
    await audit(executor, {
      actor: input.actor,
      action: 'deal.stage_changed',
      entityType: 'sales_opportunity',
      entityId: input.dealId,
      metadata: { from: existing.stageId, to: stageId, stage: stage?.name ?? null },
    });
    if (existing.contactId) {
      await insertTimelineEvent(executor, {
        contactId: existing.contactId,
        channel: 'internal',
        direction: 'internal',
        actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
        actorName: input.actor,
        eventKind: 'deal_stage',
        bodyText: `Deal "${existing.name}" moved to ${stage?.name ?? 'another stage'}.`,
        provider: 'crm',
        providerMessageId: `deal-stage:${input.dealId}:${stageId}:${at.toISOString()}`,
      });
    }
  });
  return { from: existing.stageId, to: stageId };
}

/**
 * Close a deal. A win moves its contact to client, which is the operator's
 * decision alone, so a win requires the same authority as a status change. A
 * loss records why, and the contact keeps whatever status it already had.
 */
export async function closeDeal(input: {
  dealId: string;
  actor: string;
  outcome?: unknown;
  amount?: unknown;
  reason?: unknown;
}): Promise<{ status: 'won' | 'lost'; contactId: string | null; clientStatusChanged: boolean }> {
  const outcome = input.outcome === 'won' || input.outcome === 'lost' ? input.outcome : null;
  if (!outcome) throw new CrmWriteError('A close needs outcome "won" or "lost".');
  if (outcome === 'won' && !lifecycleStageChangeAllowed(input.actor)) {
    throw new CrmWriteError('Only Matthew can mark a deal won, because that is what turns a contact into a client.');
  }
  const [existing] = await db.select().from(salesOpportunities).where(eq(salesOpportunities.id, input.dealId)).limit(1);
  if (!existing) throw new CrmWriteError('Deal not found');
  if (existing.status === 'won' || existing.status === 'lost') {
    throw new CrmWriteError(`That deal is already ${existing.status}.`);
  }
  const amountCents = input.amount === undefined || input.amount === null || input.amount === ''
    ? existing.amountCents
    : parseAmountCents(input.amount);
  const reason = clean(input.reason);
  const at = new Date();
  let clientStatusChanged = false;
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(salesOpportunities).set({
      status: outcome,
      closedAt: at,
      amountCents,
      ...(outcome === 'won' ? { wonReason: reason, lostReason: null } : { lostReason: reason, wonReason: null }),
      updatedAt: at,
    }).where(eq(salesOpportunities.id, input.dealId));
    if (outcome === 'won' && existing.contactId) {
      const [contact] = await executor
        .select({ stage: contacts.lifecycleStage })
        .from(contacts)
        .where(eq(contacts.id, existing.contactId))
        .limit(1);
      if (contact && contact.stage !== 'client') {
        await executor.update(contacts).set({
          lifecycleStage: 'client',
          lifecycleStageChangedAt: at,
          lifecycleStageChangedBy: input.actor,
          updatedAt: at,
        }).where(eq(contacts.id, existing.contactId));
        clientStatusChanged = true;
      }
    }
    await audit(executor, {
      actor: input.actor,
      action: outcome === 'won' ? 'deal.won' : 'deal.lost',
      entityType: 'sales_opportunity',
      entityId: input.dealId,
      metadata: { amountCents, reason, contactId: existing.contactId, clientStatusChanged },
    });
    if (existing.contactId) {
      await insertTimelineEvent(executor, {
        contactId: existing.contactId,
        channel: 'internal',
        direction: 'internal',
        actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
        actorName: input.actor,
        eventKind: outcome === 'won' ? 'deal_won' : 'deal_lost',
        bodyText: `Deal "${existing.name}" ${outcome}${amountCents ? ` — $${amountToNumber(amountCents).toLocaleString('en-US')}` : ''}${reason ? ` (${reason})` : ''}.`,
        provider: 'crm',
        providerMessageId: `deal-close:${input.dealId}:${outcome}:${at.toISOString()}`,
      });
      if (clientStatusChanged) {
        await insertTimelineEvent(executor, {
          contactId: existing.contactId,
          channel: 'internal',
          direction: 'internal',
          actorType: 'operator',
          actorName: input.actor,
          eventKind: 'lifecycle_stage',
          bodyText: 'Client status: → client (deal won).',
          provider: 'crm',
          providerMessageId: `deal-client:${existing.contactId}:${at.toISOString()}`,
        });
      }
    }
  });
  return { status: outcome, contactId: existing.contactId, clientStatusChanged };
}

// ─── Companies ───────────────────────────────────────────────────────────────

export interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  employeeCount: number | null;
  contactCount: number;
  openDeals: number;
  openValueUsd: number;
  wonValueUsd: number;
}

export async function listCompanies(input: { query?: string | null; industry?: string | null; limit?: number } = {}): Promise<CompanyRow[]> {
  const clauses = [eq(companies.organizationId, CRM_ORGANIZATION_ID)];
  const term = clean(input.query);
  if (term) {
    clauses.push(sql`(
      lower(${companies.name}) LIKE ${`%${term.toLowerCase()}%`}
      OR lower(coalesce(${companies.domain}, '')) LIKE ${`%${term.toLowerCase()}%`}
      OR lower(coalesce(${companies.industry}, '')) LIKE ${`%${term.toLowerCase()}%`}
    )`);
  }
  const industry = clean(input.industry);
  if (industry) clauses.push(sql`lower(coalesce(${companies.industry}, '')) = ${industry.toLowerCase()}`);
  // In a single-table select list Drizzle renders ${companies.id} as a bare "id",
  // which inside these subqueries resolves to the deal's or contact's OWN id, so
  // every count and total came back 0. Qualify it by hand.
  const outerCompanyId = sql.raw('"companies"."id"');
  const rows = await db
    .select({
      company: companies,
      contactCount: sql<number>`(
        SELECT count(*) FROM contacts c
        WHERE c.company_id = ${outerCompanyId} AND c.organization_id = ${CRM_ORGANIZATION_ID} AND c.status <> 'merged'
      )`,
      openDeals: sql<number>`(
        SELECT count(*) FROM sales_opportunities d
        WHERE d.company_id = ${outerCompanyId} AND d.status NOT IN ('won', 'lost')
      )`,
      openValue: sql<string | null>`(
        SELECT coalesce(sum(d.amount_cents), 0) FROM sales_opportunities d
        WHERE d.company_id = ${outerCompanyId} AND d.status NOT IN ('won', 'lost')
      )`,
      wonValue: sql<string | null>`(
        SELECT coalesce(sum(d.amount_cents), 0) FROM sales_opportunities d
        WHERE d.company_id = ${outerCompanyId} AND d.status = 'won'
      )`,
    })
    .from(companies)
    .where(and(...clauses))
    .orderBy(asc(companies.name))
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 500));
  return rows.map((row) => ({
    id: row.company.id,
    name: row.company.name,
    domain: row.company.domain,
    website: row.company.website,
    industry: row.company.industry,
    employeeCount: row.company.employeeCount,
    contactCount: Number(row.contactCount ?? 0),
    openDeals: Number(row.openDeals ?? 0),
    openValueUsd: amountToNumber(row.openValue),
    wonValueUsd: amountToNumber(row.wonValue),
  }));
}

export interface CompanyPage {
  company: typeof companies.$inferSelect;
  contacts: Array<{
    id: string;
    name: string;
    email: string | null;
    phoneE164: string | null;
    title: string | null;
    city: string | null;
    state: string | null;
    lifecycleStage: string;
    doNotContact: boolean;
    lastContactedAt: Date | null;
    nextFollowUpAt: Date | null;
  }>;
  deals: DealRow[];
  totals: { openValueUsd: number; openCount: number; wonValueUsd: number; wonCount: number; lostCount: number };
  openTasks: number;
  lastActivityAt: Date | null;
}

/** One page per company: every contact, every deal, and what it adds up to. */
export async function getCompanyPage(input: { companyId: string }): Promise<CompanyPage> {
  const [company] = await db.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!company) throw new CrmWriteError('Company not found');
  const contactRows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      organizationName: contacts.organizationName,
      email: contacts.email,
      phoneE164: contacts.phoneE164,
      title: contacts.title,
      city: contacts.city,
      state: contacts.state,
      lifecycleStage: contacts.lifecycleStage,
      doNotContact: contacts.doNotContact,
      lastContactedAt: contacts.lastContactedAt,
      nextFollowUpAt: contacts.nextFollowUpAt,
    })
    .from(contacts)
    .where(and(
      eq(contacts.companyId, input.companyId),
      eq(contacts.organizationId, CRM_ORGANIZATION_ID),
      sql`${contacts.status} <> 'merged'`,
    ))
    .orderBy(desc(contacts.updatedAt))
    .limit(500);
  const deals = await listDeals({ companyId: input.companyId, limit: 500 });
  const contactIds = contactRows.map((row) => row.id);
  const [taskRow] = contactIds.length
    ? await db
        .select({ n: sql<number>`count(*)` })
        .from(crmTasks)
        .where(and(eq(crmTasks.status, 'open'), inArray(crmTasks.contactId, contactIds)))
    : [{ n: 0 }];
  const [activity] = contactIds.length
    ? await db
        .select({ last: sql<Date | null>`max(${contactTimeline.occurredAt})` })
        .from(contactTimeline)
        .where(inArray(contactTimeline.contactId, contactIds))
    : [{ last: null }];
  const openDeals = deals.filter((deal) => isOpenDealStatus(deal.status));
  const wonDeals = deals.filter((deal) => deal.status === 'won');
  return {
    company,
    contacts: contactRows.map((row) => ({
      id: row.id,
      name: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.organizationName || 'Unnamed contact',
      email: row.email,
      phoneE164: row.phoneE164,
      title: row.title,
      city: row.city,
      state: row.state,
      lifecycleStage: row.lifecycleStage,
      doNotContact: row.doNotContact,
      lastContactedAt: row.lastContactedAt,
      nextFollowUpAt: row.nextFollowUpAt,
    })),
    deals,
    totals: {
      openValueUsd: openDeals.reduce((sum, deal) => sum + deal.amountUsd, 0),
      openCount: openDeals.length,
      wonValueUsd: wonDeals.reduce((sum, deal) => sum + deal.amountUsd, 0),
      wonCount: wonDeals.length,
      lostCount: deals.filter((deal) => deal.status === 'lost').length,
    },
    openTasks: Number(taskRow?.n ?? 0),
    lastActivityAt: (activity?.last as Date | null) ?? null,
  };
}

