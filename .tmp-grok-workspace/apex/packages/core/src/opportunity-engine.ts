import { createHash } from 'crypto';

export const OPPORTUNITY_CATEGORIES = [
  'product_growth',
  'revenue',
  'efficiency',
  'reliability',
  'user_experience',
  'security',
  'prompt_improvement',
  'cost_optimization',
  'automation',
  'distribution',
  'consolidation',
  'self_improvement',
] as const;

export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];
export type OpportunityImpact = 'high' | 'medium' | 'low';
export type OpportunityEffort = 'easy' | 'medium' | 'hard';

export interface OpportunityCandidate {
  title: string;
  description: string;
  rationale: string;
  category: OpportunityCategory;
  impact: OpportunityImpact;
  difficulty: OpportunityEffort;
  confidence: number;
  novelty: number;
  evidence: Record<string, unknown>;
  proposedPlan: Record<string, unknown>;
  goalTitle: string;
  goalDescription: string;
  goalPriority: number;
}

export const MAX_DYNAMIC_PROJECT_JOBS = 40;

export function recurringProjectPolicy(status: string, autonomyLevel: string): {
  eligible: boolean;
  cronExpression: string | null;
} {
  if (status !== 'active' || autonomyLevel === 'manual') {
    return { eligible: false, cronExpression: null };
  }
  return {
    eligible: true,
    cronExpression: autonomyLevel === 'full_autonomous' ? '17 */6 * * *' : '17 10 * * *',
  };
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'for', 'from', 'in', 'into', 'of', 'on',
  'or', 'the', 'to', 'with', 'your', 'this', 'that', 'improve', 'improvement',
]);

export function normalizeOpportunityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .sort()
    .join(' ');
}

export function opportunityFingerprint(projectId: string | null, title: string, description = ''): string {
  const normalized = normalizeOpportunityText(`${title} ${description.slice(0, 240)}`);
  return createHash('sha256')
    .update(`${projectId ?? 'apex'}:${normalized}`)
    .digest('hex');
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeOpportunityText(value).split(' ').filter(Boolean));
}

export function opportunitySimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = new Set([...a, ...b]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.min(a.size, b.size);
  // Containment catches a concise idea being padded into a longer paraphrase;
  // plain Jaccard alone incorrectly treats the added filler as novelty.
  return Math.max(jaccard, containment);
}

export function isNearDuplicate(candidate: string, prior: string[], threshold = 0.72): boolean {
  return prior.some((value) => opportunitySimilarity(candidate, value) >= threshold);
}

export function isGenericHumanHandoffSuggestion(title: string, description: string): boolean {
  return /\b(hand(?:\s|-)?off|delegate|escalate|send)\b.{0,32}\b(to\s+)?(a\s+)?human\b|\bask\b.{0,24}\bhuman\b.{0,24}\b(approval|permission|help)\b/i
    .test(`${title} ${description.slice(0, 240)}`);
}

export function opportunityValueScore(input: Pick<OpportunityCandidate, 'impact' | 'difficulty' | 'confidence' | 'novelty'>): number {
  const impact = { high: 1, medium: 0.65, low: 0.35 }[input.impact];
  const effort = { easy: 1, medium: 0.7, hard: 0.4 }[input.difficulty];
  const confidence = Math.max(0, Math.min(1, input.confidence));
  const novelty = Math.max(0, Math.min(1, input.novelty));
  return Math.round((impact * 0.4 + confidence * 0.25 + novelty * 0.2 + effort * 0.15) * 100);
}

function numberInRange(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function textValue(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseOpportunityCandidates(raw: string, maxCandidates = 5): OpportunityCandidate[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const arrayText = fenced ?? raw.match(/\[[\s\S]*\]/)?.[0] ?? raw;
  let decoded: unknown;
  try {
    decoded = JSON.parse(arrayText);
  } catch {
    return [];
  }
  const rows = Array.isArray(decoded)
    ? decoded
    : Array.isArray((decoded as { opportunities?: unknown[] })?.opportunities)
      ? (decoded as { opportunities: unknown[] }).opportunities
      : [];

  return rows.slice(0, Math.max(0, maxCandidates)).flatMap((unknownRow) => {
    const row = recordValue(unknownRow);
    const title = textValue(row.title, 180);
    const description = textValue(row.description, 2_000);
    if (!title || !description) return [];
    if (isGenericHumanHandoffSuggestion(title, description)) return [];
    const category = OPPORTUNITY_CATEGORIES.includes(row.category as OpportunityCategory)
      ? row.category as OpportunityCategory
      : 'product_growth';
    const impact = ['high', 'medium', 'low'].includes(String(row.impact))
      ? row.impact as OpportunityImpact
      : 'medium';
    const difficulty = ['easy', 'medium', 'hard'].includes(String(row.difficulty))
      ? row.difficulty as OpportunityEffort
      : 'medium';
    return [{
      title,
      description,
      rationale: textValue(row.rationale, 1_500) || description,
      category,
      impact,
      difficulty,
      confidence: numberInRange(row.confidence, 0.65),
      novelty: numberInRange(row.novelty, 0.7),
      evidence: recordValue(row.evidence),
      proposedPlan: recordValue(row.proposedPlan),
      goalTitle: textValue(row.goalTitle, 180) || title,
      goalDescription: textValue(row.goalDescription, 4_000) || description,
      goalPriority: Math.max(1, Math.min(10, Math.round(Number(row.goalPriority) || 5))),
    }];
  });
}
