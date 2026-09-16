import crypto from 'node:crypto';

export interface StrategySemantics {
  recommendationType: string;
  affectedRole?: string | null;
  failureCategory?: string | null;
  proposedAction: string;
  insightType?: string | null;
}

function normalize(value: string | null | undefined): string {
  return (value ?? 'none')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?%\b/g, '')
    .replace(/\b\d+\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_') || 'none';
}

/** Stable across timestamps, counts, percentages, generated ids, and prose. */
export function strategyFingerprint(input: StrategySemantics): string {
  const canonical = [
    normalize(input.recommendationType),
    normalize(input.affectedRole),
    normalize(input.failureCategory),
    normalize(input.proposedAction),
    normalize(input.insightType),
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function inferLegacyStrategySemantics(input: {
  recommendationType: string;
  title: string;
  text: string;
  evidence?: Record<string, unknown> | null;
}): StrategySemantics {
  const role = typeof input.evidence?.role === 'string'
    ? input.evidence.role
    : input.title.match(/(?:for\s+role|for|role)\s+(.+)$/i)?.[1]?.trim();
  const errorType = typeof input.evidence?.errorType === 'string' ? input.evidence.errorType : null;
  const isConcurrency = /concurrenc/i.test(`${input.title} ${input.text}`);
  const isFailure = input.recommendationType === 'error_mitigation' || /fail|error/i.test(input.title);
  return {
    recommendationType: input.recommendationType,
    affectedRole: role,
    failureCategory: errorType ?? (isFailure ? 'role_failure_rate' : 'none'),
    proposedAction: isConcurrency ? 'increase_task_concurrency' : isFailure ? 'cluster_and_mitigate_causal_failures' : 'remove_dominant_latency_source',
    insightType: isFailure ? 'failure' : 'duration',
  };
}
