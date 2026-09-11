import { z } from 'zod';
import type { ToolDefinition } from './types.js';

const SUPABASE_URL = () => process.env.BUILDMYBOT_SUPABASE_URL ?? '';
const SERVICE_KEY = () => process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY ?? '';

interface RetentionOfferAudit {
  timestamp?: string;
  planKey?: string;
  planName?: string;
  objection?: string;
  listedMonthlyPrice?: number;
  offerStage?: string;
  temporaryMonthlyPrice?: number;
  temporaryMonths?: number;
  reason?: string;
  competitorName?: string;
  desiredOutcome?: string;
  accepted?: boolean | null;
  outcomeNote?: string;
}

interface BuildMyBotCallRow {
  id?: string;
  created_at?: string;
  ended_at?: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
}

interface StageSummary {
  offers: number;
  accepted: number;
  rejected: number;
  pending: number;
  acceptanceRate: number | null;
  averageListedPrice: number | null;
  averageTemporaryPrice: number | null;
  averageTemporaryToListRatio: number | null;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

async function sbFetch(table: string, query: string): Promise<unknown> {
  const baseUrl = SUPABASE_URL();
  const serviceKey = SERVICE_KEY();
  if (!baseUrl.startsWith('https://') || !serviceKey) {
    throw new Error('BuildMyBot Supabase service connection is not configured.');
  }
  const response = await fetch(`${baseUrl}/rest/v1/${table}${query}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`BuildMyBot Supabase ${response.status} on ${table}: ${body.slice(0, 300)}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function asCallRows(value: unknown): BuildMyBotCallRow[] {
  return Array.isArray(value) ? (value as BuildMyBotCallRow[]) : [];
}

function auditEntries(row: BuildMyBotCallRow): RetentionOfferAudit[] {
  const value = row.metadata?.retentionAudit;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is RetentionOfferAudit => Boolean(entry && typeof entry === 'object'));
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function summarizeRetentionRows(rows: BuildMyBotCallRow[]) {
  const callsWithRetention = rows.filter((row) => auditEntries(row).length > 0);
  const offers = callsWithRetention.flatMap((row) => auditEntries(row));
  const accepted = offers.filter((offer) => offer.accepted === true).length;
  const rejected = offers.filter((offer) => offer.accepted === false).length;
  const pending = offers.length - accepted - rejected;
  const decided = accepted + rejected;

  const stageMap = new Map<string, RetentionOfferAudit[]>();
  const objectionMap = new Map<string, RetentionOfferAudit[]>();
  for (const offer of offers) {
    const stage = offer.offerStage || 'unknown';
    stageMap.set(stage, [...(stageMap.get(stage) ?? []), offer]);
    const objection = offer.objection || 'unknown';
    objectionMap.set(objection, [...(objectionMap.get(objection) ?? []), offer]);
  }

  const summarizeGroup = (group: RetentionOfferAudit[]): StageSummary => {
    const groupAccepted = group.filter((offer) => offer.accepted === true).length;
    const groupRejected = group.filter((offer) => offer.accepted === false).length;
    const groupPending = group.length - groupAccepted - groupRejected;
    const groupDecided = groupAccepted + groupRejected;
    const listed = group.map((offer) => safeNumber(offer.listedMonthlyPrice)).filter((value): value is number => value !== null);
    const temporary = group.map((offer) => safeNumber(offer.temporaryMonthlyPrice)).filter((value): value is number => value !== null);
    const ratios = group
      .map((offer) => {
        const list = safeNumber(offer.listedMonthlyPrice);
        const temp = safeNumber(offer.temporaryMonthlyPrice);
        return list && temp !== null ? temp / list : null;
      })
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const average = (values: number[]) =>
      values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    return {
      offers: group.length,
      accepted: groupAccepted,
      rejected: groupRejected,
      pending: groupPending,
      acceptanceRate: groupDecided ? round(groupAccepted / groupDecided) : null,
      averageListedPrice: average(listed),
      averageTemporaryPrice: average(temporary),
      averageTemporaryToListRatio: average(ratios),
    };
  };

  const ownerEscalations = rows.filter((row) => row.metadata?.ownerEscalationRequested === true).length;
  const fallbackCalls = rows.filter((row) => typeof row.metadata?.fallbackReason === 'string').length;

  return {
    sampledCalls: rows.length,
    callsWithRetention: callsWithRetention.length,
    offersIssued: offers.length,
    accepted,
    rejected,
    pending,
    acceptanceRate: decided ? round(accepted / decided) : null,
    ownerEscalations,
    fallbackCalls,
    byStage: Object.fromEntries(
      [...stageMap.entries()].map(([stage, group]) => [stage, summarizeGroup(group)]),
    ),
    byObjection: Object.fromEntries(
      [...objectionMap.entries()].map(([objection, group]) => [objection, summarizeGroup(group)]),
    ),
  };
}

function sanitizeRecentCases(rows: BuildMyBotCallRow[], limit: number) {
  return rows
    .filter((row) => auditEntries(row).length > 0 || row.metadata?.ownerEscalationRequested === true)
    .slice(0, limit)
    .map((row) => ({
      callId: row.id,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      status: row.status,
      offers: auditEntries(row),
      ownerEscalationRequested: row.metadata?.ownerEscalationRequested === true,
      ownerEscalationHandoff:
        row.metadata?.ownerEscalationHandoff && typeof row.metadata.ownerEscalationHandoff === 'object'
          ? row.metadata.ownerEscalationHandoff
          : undefined,
      fallbackReason:
        typeof row.metadata?.fallbackReason === 'string' ? row.metadata.fallbackReason : undefined,
    }));
}

async function loadCallWindow(days: number, limit: number): Promise<BuildMyBotCallRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await sbFetch(
    'call_logs',
    buildQuery({
      created_at: `gte.${since}`,
      order: 'created_at.desc',
      limit,
      select: 'id,created_at,ended_at,status,metadata',
    }),
  );
  return asCallRows(rows);
}

export function createBuildMyBotRetentionTools(): ToolDefinition[] {
  return [
    {
      name: 'buildmybot_retention_performance',
      description:
        'Analyze BuildMyBot live-call retention outcomes from server-side audit metadata. Shows which incentive stages and objection types actually close, plus owner escalations and voice fallbacks. Read-only: this tool never authorizes a discount and must not be used as a second pricing authority.',
      schema: z.object({
        days: z.number().int().min(1).max(90).optional().describe('Lookback window in days; default 14'),
        sampleLimit: z
          .number()
          .int()
          .min(25)
          .max(1000)
          .optional()
          .describe('Maximum recent call rows to inspect; default 500'),
      }),
      requiresApproval: false,
      async execute({ days, sampleLimit }) {
        const lookbackDays = days ?? 14;
        const rows = await loadCallWindow(lookbackDays, sampleLimit ?? 500);
        return {
          lookbackDays,
          policyAuthority:
            'BuildMyBot live runtime is the sole authority for offer amounts, sequencing, floor enforcement and duration. APEX observes outcomes only.',
          ...summarizeRetentionRows(rows),
        };
      },
    },
    {
      name: 'buildmybot_retention_cases',
      description:
        'Inspect recent BuildMyBot retention or owner-escalation cases with their internal handoff summaries and offer audit trail. Confidential transfer destinations are intentionally absent because BuildMyBot never writes them into model-visible audit metadata.',
      schema: z.object({
        days: z.number().int().min(1).max(30).optional().describe('Lookback window in days; default 7'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum cases returned; default 20'),
      }),
      requiresApproval: false,
      async execute({ days, limit }) {
        const rows = await loadCallWindow(days ?? 7, 500);
        return sanitizeRecentCases(rows, limit ?? 20);
      },
    },
    {
      name: 'buildmybot_voice_runtime_performance',
      description:
        'Summarize recent BuildMyBot realtime voice runtime health from call metadata: provider/model distribution, fallbacks, interruptions and AI department handoffs. Use this before changing voice-provider strategy; it reports observed runtime telemetry rather than vendor marketing claims.',
      schema: z.object({
        days: z.number().int().min(1).max(30).optional().describe('Lookback window in days; default 7'),
        sampleLimit: z.number().int().min(25).max(1000).optional().describe('Maximum calls to inspect; default 500'),
      }),
      requiresApproval: false,
      async execute({ days, sampleLimit }) {
        const lookbackDays = days ?? 7;
        const rows = await loadCallWindow(lookbackDays, sampleLimit ?? 500);
        const models: Record<string, number> = {};
        const providers: Record<string, number> = {};
        let fallbackCalls = 0;
        let totalInterruptions = 0;
        let totalHandoffs = 0;
        for (const row of rows) {
          const metadata = row.metadata ?? {};
          const model = typeof metadata.model === 'string' ? metadata.model : 'unknown';
          const provider = typeof metadata.provider === 'string' ? metadata.provider : 'unknown';
          models[model] = (models[model] ?? 0) + 1;
          providers[provider] = (providers[provider] ?? 0) + 1;
          if (typeof metadata.fallbackReason === 'string') fallbackCalls += 1;
          if (typeof metadata.interruptions === 'number') totalInterruptions += metadata.interruptions;
          if (Array.isArray(metadata.voiceHandoffs)) totalHandoffs += metadata.voiceHandoffs.length;
        }
        return {
          lookbackDays,
          sampledCalls: rows.length,
          providers,
          models,
          fallbackCalls,
          fallbackRate: rows.length ? round(fallbackCalls / rows.length) : null,
          totalInterruptions,
          averageInterruptionsPerCall: rows.length ? round(totalInterruptions / rows.length) : null,
          totalDepartmentHandoffs: totalHandoffs,
          averageDepartmentHandoffsPerCall: rows.length ? round(totalHandoffs / rows.length) : null,
        };
      },
    },
  ];
}
