/**
 * CRM phase 3: the reports page's arithmetic.
 *
 * Three questions: where deals are, what has actually been won, and which
 * channels and industries answer. Everything is computed from the records the
 * CRM already holds, so a number here can be traced back to the row it came
 * from. The pure helpers (rates, funnel conversion) are split out so they can be
 * checked without a database.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  auditEvents,
  companies,
  contactTimeline,
  contacts,
  db,
  pipelineStages,
  salesOpportunities,
} from '@workspace/db';
import { CRM_ORGANIZATION_ID, chicagoDayBounds, chicagoDateKey } from './pure.js';

export interface CrmReportsWindow {
  from: Date;
  to: Date;
  label: string;
}

/** The window the reports read, defaulting to the last 90 days. */
export function reportsWindow(input: { from?: string | null; to?: string | null; days?: number } = {}): CrmReportsWindow {
  const now = new Date();
  const to = input.to ? new Date(input.to) : now;
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - Math.max(1, Math.min(input.days ?? 90, 730)) * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('from and to must be valid dates.');
  }
  return { from, to, label: `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}` };
}

/** A reply rate as a percentage, guarded against a zero denominator. */
export function rate(replies: number, sends: number): number {
  if (sends <= 0) return 0;
  return Math.round((replies / sends) * 1000) / 10;
}

/** Share of the cohort that reached the next step, in percent. */
export function conversionRate(reached: number, previousReached: number): number {
  if (previousReached <= 0) return 0;
  return Math.round((reached / previousReached) * 1000) / 10;
}

export interface FunnelRow {
  stageId: string | null;
  name: string;
  position: number | null;
  reached: number;
  openNow: number;
  openValueUsd: number;
  conversionFromPrevious: number | null;
}

export interface ChannelReplyRow {
  channel: string;
  outbound: number;
  replies: number;
  rate: number;
}

export interface IndustryReplyRow {
  industry: string;
  outbound: number;
  replies: number;
  rate: number;
}

export interface CrmReports {
  window: { from: string; to: string; label: string };
  funnel: FunnelRow[];
  revenue: {
    wonCount: number;
    wonUsd: number;
    averageWonUsd: number;
    wonThisMonthUsd: number;
    lostCount: number;
    lostUsd: number;
    lostReasons: Array<{ reason: string; count: number; valueUsd: number }>;
    openUsd: number;
    openCount: number;
  };
  replies: {
    byChannel: ChannelReplyRow[];
    byIndustry: IndustryReplyRow[];
    totalOutbound: number;
    totalReplies: number;
  };
  asOf: Date;
}

/**
 * The start of the current month in the display timezone, as an instant. Built
 * from midnight today minus the days already elapsed, so the same offset that
 * bounds "today" bounds the month.
 */
export function startOfChicagoMonth(now: Date = new Date()): Date {
  const { start } = chicagoDayBounds(now);
  const dayOfMonth = Number(chicagoDateKey(now).split('-')[2]);
  return new Date(start.getTime() - (dayOfMonth - 1) * 86_400_000);
}

export async function crmReports(input: { from?: string | null; to?: string | null; days?: number } = {}): Promise<CrmReports> {
  const window = reportsWindow(input);
  const money = (value: string | number | null | undefined) => Number(value ?? 0) / 100;

  const stages = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.organizationId, CRM_ORGANIZATION_ID))
    .orderBy(pipelineStages.position);

  // Which deals ever reached which stage. There is no per-deal history table, so
  // the honest source is the audit trail: a create records the stage it opened
  // in, and every move records the stage it moved to.
  const reachedRows = await db
    .select({
      stageId: sql<string | null>`coalesce(${auditEvents.metadata}->>'stageId', ${auditEvents.metadata}->>'to')`,
      dealId: auditEvents.entityId,
    })
    .from(auditEvents)
    .where(and(
      eq(auditEvents.organizationId, CRM_ORGANIZATION_ID),
      eq(auditEvents.entityType, 'sales_opportunity'),
      sql`${auditEvents.action} IN ('deal.created', 'deal.stage_changed')`,
    ));
  const reachedByStage = new Map<string, Set<string>>();
  for (const row of reachedRows) {
    if (!row.stageId) continue;
    const set = reachedByStage.get(row.stageId) ?? new Set<string>();
    set.add(row.dealId ?? '');
    reachedByStage.set(row.stageId, set);
  }

  const dealRows = await db
    .select({
      status: salesOpportunities.status,
      stageId: salesOpportunities.stageId,
      amountCents: salesOpportunities.amountCents,
      closedAt: salesOpportunities.closedAt,
      lostReason: salesOpportunities.lostReason,
      wonReason: salesOpportunities.wonReason,
    })
    .from(salesOpportunities)
    .where(eq(salesOpportunities.organizationId, CRM_ORGANIZATION_ID))
    .limit(2000);

  const openDeals = dealRows.filter((deal) => deal.status !== 'won' && deal.status !== 'lost');
  const wonDeals = dealRows.filter((deal) => deal.status === 'won');
  const lostDeals = dealRows.filter((deal) => deal.status === 'lost');
  const monthStart = startOfChicagoMonth();
  const lostReasonMap = new Map<string, { count: number; valueUsd: number }>();
  for (const deal of lostDeals) {
    const reason = (deal.lostReason ?? '').trim() || 'no reason recorded';
    const entry = lostReasonMap.get(reason) ?? { count: 0, valueUsd: 0 };
    entry.count += 1;
    entry.valueUsd += money(deal.amountCents);
    lostReasonMap.set(reason, entry);
  }

  const funnel: FunnelRow[] = [];
  let previousReached = 0;
  stages.forEach((stage, index) => {
    const reached = reachedByStage.get(stage.id)?.size ?? 0;
    const inStage = openDeals.filter((deal) => deal.stageId === stage.id);
    funnel.push({
      stageId: stage.id,
      name: stage.name,
      position: stage.position,
      // A deal sitting in a later stage has reached this one even if the audit
      // row was pruned; take the larger of the two counts rather than undercount.
      reached: Math.max(reached, inStage.length),
      openNow: inStage.length,
      openValueUsd: inStage.reduce((sum, deal) => sum + money(deal.amountCents), 0),
      conversionFromPrevious: index === 0 ? null : conversionRate(reached, previousReached),
    });
    previousReached = Math.max(reached, inStage.length);
  });

  const channelRows = await db
    .select({
      channel: contactTimeline.channel,
      outbound: sql<number>`count(*) FILTER (WHERE ${contactTimeline.direction} = 'outbound')`,
      replies: sql<number>`count(*) FILTER (WHERE ${contactTimeline.direction} = 'inbound' AND ${contactTimeline.eventKind} IN ('reply', 'message'))`,
    })
    .from(contactTimeline)
    .where(and(
      eq(contactTimeline.organizationId, CRM_ORGANIZATION_ID),
      gte(contactTimeline.occurredAt, window.from),
      lte(contactTimeline.occurredAt, window.to),
    ))
    .groupBy(contactTimeline.channel)
    .orderBy(desc(sql`count(*)`));

  const industryRows = await db
    .select({
      industry: companies.industry,
      outbound: sql<number>`count(*) FILTER (WHERE ${contactTimeline.direction} = 'outbound')`,
      replies: sql<number>`count(*) FILTER (WHERE ${contactTimeline.direction} = 'inbound' AND ${contactTimeline.eventKind} IN ('reply', 'message'))`,
    })
    .from(contactTimeline)
    .leftJoin(contacts, eq(contacts.id, contactTimeline.contactId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(
      eq(contactTimeline.organizationId, CRM_ORGANIZATION_ID),
      gte(contactTimeline.occurredAt, window.from),
      lte(contactTimeline.occurredAt, window.to),
    ))
    .groupBy(companies.industry);

  const byChannel = channelRows.map((row) => ({
    channel: row.channel,
    outbound: Number(row.outbound ?? 0),
    replies: Number(row.replies ?? 0),
    rate: rate(Number(row.replies ?? 0), Number(row.outbound ?? 0)),
  }));
  const byIndustry = industryRows
    .map((row) => ({
      industry: (row.industry ?? '').trim() || 'industry not recorded',
      outbound: Number(row.outbound ?? 0),
      replies: Number(row.replies ?? 0),
      rate: rate(Number(row.replies ?? 0), Number(row.outbound ?? 0)),
    }))
    .sort((a, b) => b.outbound - a.outbound)
    .slice(0, 25);

  const wonUsd = wonDeals.reduce((sum, deal) => sum + money(deal.amountCents), 0);
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString(), label: window.label },
    funnel,
    revenue: {
      wonCount: wonDeals.length,
      wonUsd,
      averageWonUsd: wonDeals.length > 0 ? Math.round((wonUsd / wonDeals.length) * 100) / 100 : 0,
      wonThisMonthUsd: wonDeals
        .filter((deal) => deal.closedAt && new Date(deal.closedAt) >= monthStart)
        .reduce((sum, deal) => sum + money(deal.amountCents), 0),
      lostCount: lostDeals.length,
      lostUsd: lostDeals.reduce((sum, deal) => sum + money(deal.amountCents), 0),
      lostReasons: [...lostReasonMap.entries()]
        .map(([reason, entry]) => ({ reason, ...entry }))
        .sort((a, b) => b.count - a.count),
      openUsd: openDeals.reduce((sum, deal) => sum + money(deal.amountCents), 0),
      openCount: openDeals.length,
    },
    replies: {
      byChannel,
      byIndustry,
      totalOutbound: byChannel.reduce((sum, row) => sum + row.outbound, 0),
      totalReplies: byChannel.reduce((sum, row) => sum + row.replies, 0),
    },
    asOf: new Date(),
  };
}