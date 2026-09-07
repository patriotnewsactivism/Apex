export interface BusinessOutcomeEvidenceRow {
  actor: string;
  responsible_agent_id?: string | null;
  responsible_workflow?: string | null;
  measured_outcomes: number;
  quality?: number | null;
  target_attainment?: number | null;
  measured_sourced_revenue: number;
  measured_cost: number;
  measured_direct_roi?: number | null;
}

export interface BusinessOutcomeEvaluation {
  actor: string;
  responsibleAgentId: string | null;
  responsibleWorkflow: string | null;
  metric: 'business_outcome_score';
  score: number | null;
  confidence: number;
  sampleSize: number;
  components: {
    quality: number | null;
    targetAttainment: number | null;
    commercialEfficiency: number | null;
  };
  measuredEconomics: {
    sourcedRevenue: number;
    cost: number;
    directRoi: number | null;
  };
  evidenceClass: 'MEASURED';
  note: string;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roiToScore(roi: number | null | undefined): number | null {
  if (roi === null || roi === undefined || !Number.isFinite(roi)) return null;
  // -100% direct ROI maps to 0, break-even to 0.5, +100% to 1.
  // Values outside that interval are capped rather than allowed to dominate
  // operational quality or target attainment.
  return clamp01((roi + 1) / 2);
}

export class BusinessOutcomeEvaluator {
  evaluate(rows: BusinessOutcomeEvidenceRow[]): BusinessOutcomeEvaluation[] {
    return rows.map((row) => {
      const quality = row.quality === null || row.quality === undefined ? null : clamp01(Number(row.quality));
      const targetAttainment = row.target_attainment === null || row.target_attainment === undefined
        ? null
        : clamp01(Number(row.target_attainment));
      const commercialEfficiency = roiToScore(row.measured_direct_roi);

      const weighted = [
        quality === null ? null : { value: quality, weight: 0.35 },
        targetAttainment === null ? null : { value: targetAttainment, weight: 0.35 },
        commercialEfficiency === null ? null : { value: commercialEfficiency, weight: 0.30 },
      ].filter((component): component is { value: number; weight: number } => component !== null);

      const availableWeight = weighted.reduce((sum, component) => sum + component.weight, 0);
      const score = availableWeight === 0
        ? null
        : weighted.reduce((sum, component) => sum + component.value * component.weight, 0) / availableWeight;
      const sampleSize = Number(row.measured_outcomes ?? 0);

      return {
        actor: row.actor,
        responsibleAgentId: row.responsible_agent_id ?? null,
        responsibleWorkflow: row.responsible_workflow ?? null,
        metric: 'business_outcome_score',
        score: score === null ? null : Number(score.toFixed(4)),
        confidence: Number(Math.min(1, Math.sqrt(Math.max(0, sampleSize) / 25)).toFixed(4)),
        sampleSize,
        components: { quality, targetAttainment, commercialEfficiency },
        measuredEconomics: {
          sourcedRevenue: Number(row.measured_sourced_revenue ?? 0),
          cost: Number(row.measured_cost ?? 0),
          directRoi: row.measured_direct_roi === null || row.measured_direct_roi === undefined
            ? null
            : Number(row.measured_direct_roi),
        },
        evidenceClass: 'MEASURED',
        note: score === null
          ? 'Insufficient measured business evidence; no score is fabricated.'
          : 'Score uses only available MEASURED components and renormalizes weights when a component is unavailable.',
      };
    });
  }
}
