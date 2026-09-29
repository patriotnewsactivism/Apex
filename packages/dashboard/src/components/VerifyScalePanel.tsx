import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  CircleDollarSign,
  Gauge,
  Play,
  Scale,
  ShieldCheck,
  Sparkles,
  Target,
  TriangleAlert,
} from 'lucide-react';
import { api, type Goal } from '../lib/api.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

const LOOP_STATES = [
  ['01', 'Observe', 'Measure the live baseline before changing anything.'],
  ['02', 'Hypothesize', 'Generate competing explanations and growth strategies.'],
  ['03', 'Verify', 'Challenge assumptions with evidence, QA, cost and risk checks.'],
  ['04', 'Implement', 'Make the smallest safe change that can prove the idea.'],
  ['05', 'Monitor', 'Compare post-change results to the measured baseline.'],
  ['06', 'Learn', 'Write the result back into APEX memory and outcome evidence.'],
  ['07', 'Scale', 'Expand only what produced verified value; stop what did not.'],
] as const;

const OBJECTIVES = [
  ['leadQuality', 'Lead quality', 24],
  ['leadQuantity', 'Lead quantity', 16],
  ['profit', 'Profit / ROI', 28],
  ['conversion', 'Conversion', 16],
  ['retention', 'Retention', 8],
  ['risk', 'Risk reduction', 8],
] as const;

type ObjectiveKey = (typeof OBJECTIVES)[number][0];
type Weights = Record<ObjectiveKey, number>;

const initialWeights = Object.fromEntries(
  OBJECTIVES.map(([key, , weight]) => [key, weight]),
) as Weights;

function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return '$' + value.toFixed(value >= 100 ? 0 : 2);
}

function stageStatus(goal: Goal | undefined, index: number): 'passed' | 'active' | 'blocked' | 'pending' {
  if (!goal) return 'pending';

  // A completed goal is not evidence that every governance stage passed.
  // Future Verify & Scale runs write this machine-readable footer only after
  // they have actual stage evidence; old runs stay pending rather than being
  // painted green retroactively.
  const labels = ['OBSERVE', 'HYPOTHESIZE', 'VERIFY', 'IMPLEMENT', 'MONITOR', 'LEARN', 'SCALE'];
  const result = goal.result ?? '';
  const marker = result.match(/VERIFY_SCALE_STAGE_STATUS:\s*([^\n]+)/i)?.[1] ?? '';
  const pair = marker
    .split(',')
    .map((part) => part.trim().split('='))
    .find(([name]) => name?.toUpperCase() === labels[index]);
  const declared = pair?.[1]?.trim().toLowerCase();
  if (declared === 'pass' || declared === 'passed') return 'passed';
  if (declared === 'block' || declared === 'blocked' || declared === 'fail' || declared === 'failed') return 'blocked';
  if (declared === 'active') return 'active';

  if (goal.status === 'cancelled' || goal.status === 'paused') return index === 0 ? 'blocked' : 'pending';
  if (goal.status === 'active') return index === 0 ? 'active' : 'pending';
  return 'pending';
}

export function VerifyScalePanel() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [brief, setBrief] = useState('');
  const [weights, setWeights] = useState<Weights>(initialWeights);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);

  const goalsQuery = useQuery({
    queryKey: ['verify-scale', 'goals'],
    queryFn: () => api.goals.list(),
    refetchInterval: 5000,
  });
  const spendQuery = useQuery({
    queryKey: ['verify-scale', 'spend'],
    queryFn: () => api.spend.live(),
    refetchInterval: 10000,
  });
  const approvalQuery = useQuery({
    queryKey: ['verify-scale', 'approvals'],
    queryFn: () => api.approvals.counts(),
    refetchInterval: 10000,
  });
  const healthQuery = useQuery({
    queryKey: ['verify-scale', 'health'],
    queryFn: () => api.health.report(),
    refetchInterval: 15000,
  });
  const cicdQuery = useQuery({
    queryKey: ['verify-scale', 'cicd'],
    queryFn: () => api.cicd.status(),
    refetchInterval: 15000,
  });
  const governanceQuery = useQuery({
    queryKey: ['verify-scale', 'governance'],
    queryFn: () => api.governance.status(),
    refetchInterval: 10000,
  });

  const cycles = useMemo(
    () =>
      (goalsQuery.data ?? [])
        .filter((goal) => goal.title.startsWith('[VERIFY & SCALE]'))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [goalsQuery.data],
  );
  const selected = cycles.find((goal) => goal.id === selectedGoalId) ?? cycles[0];

  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const normalized = Object.fromEntries(
    Object.entries(weights).map(([key, value]) => [
      key,
      totalWeight > 0 ? Math.round((value / totalWeight) * 100) : 0,
    ]),
  ) as Weights;

  const runCycle = useMutation({
    mutationFn: async () => {
      const operatorBrief =
        brief.trim() ||
        'Use current APEX telemetry and business outcomes to find the highest-value verified growth opportunity.';
      const objectiveText = OBJECTIVES.map(
        ([key, label]) => `${label}=${normalized[key]}%`,
      ).join(', ');

      return api.goals.submit({
        title: `[VERIFY & SCALE] ${operatorBrief.slice(0, 86)}`,
        priority: 9,
        description: [
          'Run a governed Verify & Scale cycle using the native APEX workforce.',
          '',
          `OPERATOR BRIEF: ${operatorBrief}`,
          `WEIGHTED OBJECTIVE: ${objectiveText}`,
          '',
          'SEVEN-STATE LOOP:',
          '1. OBSERVE — establish a real baseline from current telemetry, pipeline, spend, outcome evidence, and customer/revenue data. Never fabricate missing values.',
          '2. HYPOTHESIZE — generate multiple plausible strategies or root causes. State assumptions and what evidence would distinguish them.',
          '3. VERIFY — use the relevant APEX specialists to challenge lead quality, conversion impact, cost, churn/refunds, compliance, reliability, and blast radius. Prefer first-party evidence and cached research.',
          '4. IMPLEMENT — make the smallest reversible change capable of testing the hypothesis. Existing approval policy remains authoritative for risky, external, or irreversible actions.',
          '5. MONITOR — compare post-change measurements with the baseline. A successful API call, patch, deployment request, email, or tool invocation is not proof of outcome.',
          '6. LEARN — record measured outcomes separately from estimated/inferred outcomes. Preserve failures and disagreements as evidence.',
          '7. SCALE — expand only actions with verified positive value. Stop or roll back actions that worsen the weighted objective, exceed budget, or create unacceptable risk.',
          '',
          'HARD GUARDRAILS:',
          '- Respect the current APEX spend cap, provider caps, approval gates, and project autonomy policy.',
          '- Prefer the cheapest capable model/tool route and existing caches.',
          '- Do not repeat saturated searches or duplicate work.',
          '- Fail closed when verification is missing, malformed, timed out, or contradictory.',
          '- Do not call a cycle successful unless the intended state/outcome is independently verified.',
          '- Keep measured facts, estimates, and model opinions visibly separate.',
          '- A result cannot enter IMPLEMENT, LEARN, or SCALE unless the producing agent proves code, test, data, and artifact paths refer to the same deployed revision and canonical storage boundary.',
          '- If runtime provenance, consent, independent verification, budget, or approval evidence is missing, BLOCK the affected stage rather than infer success.',
          '',
          'FINAL REPORT:',
          'Return stage-by-stage status, baseline, hypotheses considered, debate/critique, selected change, automated verification, approvals used, spend impact, post-change measurements, weighted-objective result, what was learned, and whether scaling is justified.',
          'Finish with exactly one machine-readable line: VERIFY_SCALE_STAGE_STATUS: OBSERVE=pass|block, HYPOTHESIZE=pass|block, VERIFY=pass|block, IMPLEMENT=pass|block, MONITOR=pass|block, LEARN=pass|block, SCALE=pass|block. Use pass only when that stage has recorded evidence; otherwise block.',
        ].join('\n'),
      });
    },
    onSuccess: async ({ goalId }) => {
      setSelectedGoalId(goalId);
      setBrief('');
      await queryClient.invalidateQueries({ queryKey: ['verify-scale', 'goals'] });
    },
  });

  const spend = spendQuery.data;
  const approvals = approvalQuery.data;
  const health = healthQuery.data;
  const governance = governanceQuery.data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%' }}>
      <div
        className="glass-card"
        style={{
          padding: isMobile ? 16 : 22,
          minWidth: 0,
          background:
            'linear-gradient(135deg, rgba(90,158,174,0.12), rgba(17,19,24,0.94) 56%, rgba(184,149,108,0.09))',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 760, minWidth: 0 }}>
            <div className="apex-eyebrow">Observe · Hypothesize · Verify · Implement · Monitor · Learn · Scale</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
              <Sparkles size={24} color="var(--color-apex-brass)" />
              <h2 style={{ margin: 0, fontSize: isMobile ? 22 : 28 }}>Verify & Scale</h2>
            </div>
            <p style={{ margin: '9px 0 0', color: 'var(--color-apex-muted)', lineHeight: 1.55, fontSize: 13 }}>
              A native APEX growth-control loop: optimize for value, prove the change, keep budget and authority boundaries intact,
              and scale only what the evidence says worked.
            </p>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? 'repeat(2,minmax(0,1fr))' : 'repeat(4,minmax(118px,1fr))',
              gap: 8,
              width: isMobile ? '100%' : 'auto',
            }}
          >
            <Metric label="Health" value={healthQuery.isError ? 'Unavailable' : health?.overall ?? 'Loading'} icon={<Activity size={14} />} />
            <Metric label="Spend today" value={money(spend?.spentUsd)} sub={spend ? `${spend.utilizationPct.toFixed(1)}% of cap` : undefined} icon={<CircleDollarSign size={14} />} />
            <Metric label="Pending gates" value={approvals ? String((approvals.approval ?? 0) + (approvals.escalation ?? 0)) : '—'} icon={<ShieldCheck size={14} />} />
            <Metric
              label="Implement gate"
              value={governanceQuery.isError ? 'Unavailable' : governance?.implementationGate === 'ready' ? 'READY' : governance ? 'BLOCKED' : 'Loading'}
              sub={cicdQuery.isError ? 'CI unavailable' : cicdQuery.data ? 'CI/CD connected' : undefined}
              icon={<Gauge size={14} />}
            />
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1.15fr) minmax(320px,.85fr)', gap: 16, minWidth: 0 }}>
        <div className="glass-card" style={{ padding: isMobile ? 16 : 20, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Target size={16} color="var(--color-apex-signal)" />
            <div className="apex-eyebrow">Weighted objective</div>
          </div>
          <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
            {OBJECTIVES.map(([key, label]) => (
              <label key={key} style={{ display: 'grid', gridTemplateColumns: isMobile ? '110px 1fr 38px' : '150px 1fr 44px', gap: 10, alignItems: 'center', minWidth: 0 }}>
                <span style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>{label}</span>
                <input
                  aria-label={label}
                  type="range"
                  min={0}
                  max={50}
                  value={weights[key]}
                  onChange={(event) => setWeights((current) => ({ ...current, [key]: Number(event.target.value) }))}
                  style={{ width: '100%', minWidth: 0 }}
                />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'right' }}>{normalized[key]}%</span>
              </label>
            ))}
          </div>
        </div>

        <div className="glass-card" style={{ padding: isMobile ? 16 : 20, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Scale size={16} color="var(--color-apex-green)" />
            <div className="apex-eyebrow">Authority & budget line</div>
          </div>
          <div style={{ marginTop: 14, display: 'grid', gap: 9 }}>
            <Guard label="Spend cap" value={spend ? `${money(spend.spentUsd)} / ${money(spend.capUsd)}` : 'Loading'} ok={!spend || spend.state !== 'daily_cap'} />
            <Guard label="Approval boundary" value={approvals ? `${approvals.approval ?? 0} approvals · ${approvals.escalation ?? 0} escalations` : 'Loading'} ok />
            <Guard label="System health" value={health?.overall ?? 'Loading'} ok={!health || health.overall !== 'critical'} />
            <Guard
              label="Runtime provenance"
              value={governance ? `${governance.provenance.verified24h} verified · ${governance.provenance.failed24h} blocked in 24h` : 'Loading'}
              ok={!governance || governance.implementationGate === 'ready'}
            />
            <Guard
              label="Configuration drift"
              value={governance ? (governance.configuration.legacyPaidFallbackPresent ? 'Legacy paid-fallback flag still present' : `Single switch: ${governance.configuration.paidFallbackFlag}`) : 'Loading'}
              ok={!governance || !governance.configuration.legacyPaidFallbackPresent}
            />
            <Guard label="Verification rule" value="No proof = no success" ok />
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)', gap: 16, minWidth: 0 }}>
        <div className="glass-card" style={{ padding: isMobile ? 16 : 20, minWidth: 0 }}>
          <div className="apex-eyebrow">Runtime provenance · live evidence</div>
          {governanceQuery.isError ? (
            <div style={{ marginTop: 12, color: 'var(--color-apex-red)', fontSize: 12 }}>
              Governance telemetry is unavailable. Autonomous implementation should be treated as blocked.
            </div>
          ) : !governance ? (
            <div style={{ marginTop: 12, color: 'var(--color-apex-muted)', fontSize: 12 }}>Loading runtime evidence…</div>
          ) : (
            <div style={{ marginTop: 13, display: 'grid', gap: 8 }}>
              <EvidenceRow label="Deployed SHA" value={governance.runtime.buildSha} ok={governance.runtime.buildSha !== 'unknown'} mono />
              <EvidenceRow label="Canonical repo" value={governance.runtime.repoRoot} ok={governance.configuration.canonicalRepoRootConfigured} mono />
              <EvidenceRow label="Branch" value={governance.runtime.sourceBranch} ok={governance.configuration.sourceBranchConfigured} mono />
              <EvidenceRow label="Artifact root" value={governance.runtime.artifactRoot ?? 'NOT CONFIGURED'} ok={governance.configuration.artifactRootConfigured} mono />
              <EvidenceRow label="Database" value={governance.runtime.databaseConfigured ? 'Configured' : 'NOT CONFIGURED'} ok={governance.runtime.databaseConfigured} />
              <EvidenceRow
                label="Write gate"
                value={governance.implementationGate === 'ready' ? 'Writes may proceed when task provenance matches' : 'BLOCKED until provenance is clean'}
                ok={governance.implementationGate === 'ready'}
              />
              {governance.provenance.latest?.reasons.length ? (
                <div style={{ padding: 10, border: '1px solid rgba(196,92,102,.24)', borderRadius: 6, color: 'var(--color-apex-red)', fontSize: 10, lineHeight: 1.5 }}>
                  Latest blocked write: {governance.provenance.latest.reasons.join('; ')}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="glass-card" style={{ padding: isMobile ? 16 : 20, minWidth: 0 }}>
          <div className="apex-eyebrow">Outbound consent boundary · live evidence</div>
          {!governance ? (
            <div style={{ marginTop: 12, color: 'var(--color-apex-muted)', fontSize: 12 }}>Loading consent state…</div>
          ) : (
            <>
              <div style={{ marginTop: 13, display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8 }}>
                <Metric label="Allowed" value={String(governance.outbound.gateCounts.allowed)} icon={<CheckCircle2 size={14} />} />
                <Metric label="Pending" value={String(governance.outbound.gateCounts.pending)} icon={<TriangleAlert size={14} />} />
                <Metric label="Denied" value={String(governance.outbound.gateCounts.denied)} icon={<ShieldCheck size={14} />} />
              </div>
              <div style={{ marginTop: 11, display: 'grid', gap: 8 }}>
                <EvidenceRow label="Channels" value={governance.outbound.channels.join(' · ')} ok />
                <EvidenceRow label="Evaluator" value={governance.outbound.evaluator} ok mono />
                <EvidenceRow label="Missing / ambiguous consent" value="BLOCKS provider call" ok />
                <EvidenceRow label="Mode" value="FAIL CLOSED" ok />
              </div>
              <div style={{ marginTop: 10, color: 'var(--color-apex-muted)', fontSize: 10, lineHeight: 1.5 }}>
                {governance.outbound.scalingRule}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="glass-card" style={{ padding: isMobile ? 16 : 20, minWidth: 0 }}>
        <div className="apex-eyebrow">Start a governed cycle</div>
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 10, marginTop: 12 }}>
          <input
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !runCycle.isPending) runCycle.mutate();
            }}
            placeholder="Example: improve roofing campaign qualified appointments while cutting search and calling cost"
            style={{
              flex: 1,
              minWidth: 0,
              width: '100%',
              padding: '11px 12px',
              fontSize: isMobile ? 16 : 13,
              borderRadius: 6,
              border: '1px solid var(--color-apex-line)',
              background: 'rgba(0,0,0,0.16)',
              color: 'var(--color-apex-text)',
            }}
          />
          <button
            onClick={() => runCycle.mutate()}
            disabled={runCycle.isPending}
            style={{
              display: 'inline-flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 8,
              padding: '11px 15px',
              borderRadius: 6,
              border: '1px solid rgba(90,158,174,.35)',
              background: 'var(--color-apex-signal)',
              color: '#071014',
              fontWeight: 800,
              cursor: runCycle.isPending ? 'wait' : 'pointer',
              minHeight: 44,
            }}
          >
            <Play size={15} />
            {runCycle.isPending ? 'Starting…' : 'Run Verify & Scale'}
          </button>
        </div>
        {runCycle.isError && (
          <div style={{ marginTop: 9, color: 'var(--color-apex-red)', fontSize: 12 }}>
            The cycle was not started. No external action was attempted.
          </div>
        )}
      </div>

      <div>
        <div className="apex-eyebrow" style={{ marginBottom: 9 }}>Seven-state loop</div>
        <div
          style={{
            display: isMobile ? 'flex' : 'grid',
            gridTemplateColumns: isMobile ? undefined : 'repeat(7,minmax(0,1fr))',
            gap: 8,
            overflowX: isMobile ? 'auto' : undefined,
            paddingBottom: isMobile ? 4 : undefined,
          }}
        >
          {LOOP_STATES.map(([number, label, detail], index) => {
            const state = stageStatus(selected, index);
            const tone =
              state === 'passed'
                ? 'var(--color-apex-green)'
                : state === 'blocked'
                  ? 'var(--color-apex-red)'
                  : state === 'active'
                    ? 'var(--color-apex-signal)'
                    : 'var(--color-apex-muted)';
            return (
              <div
                key={label}
                className="glass-card"
                style={{
                  padding: 13,
                  minWidth: isMobile ? 190 : 0,
                  flex: isMobile ? '0 0 190px' : undefined,
                  borderTop: `2px solid ${tone}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-apex-muted)' }}>{number}</span>
                  {state === 'passed' ? <CheckCircle2 size={14} color={tone} /> : state === 'blocked' ? <TriangleAlert size={14} color={tone} /> : <BrainCircuit size={14} color={tone} />}
                </div>
                <div style={{ marginTop: 7, fontWeight: 700, fontSize: 12 }}>{label}</div>
                <div style={{ marginTop: 5, fontSize: 10, lineHeight: 1.45, color: 'var(--color-apex-muted)' }}>{detail}</div>
                <div style={{ marginTop: 9, fontFamily: 'var(--font-mono)', fontSize: 8, textTransform: 'uppercase', color: tone }}>{state}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1.3fr) minmax(280px,.7fr)', gap: 16, minWidth: 0 }}>
        <div className="glass-card" style={{ padding: isMobile ? 16 : 20, minWidth: 0 }}>
          <div className="apex-eyebrow">Current cycle evidence</div>
          {!selected ? (
            <div style={{ marginTop: 12, color: 'var(--color-apex-muted)', fontSize: 12 }}>No Verify & Scale cycle has been started yet.</div>
          ) : (
            <>
              <div style={{ marginTop: 11, fontWeight: 750, overflowWrap: 'anywhere' }}>{selected.title.replace('[VERIFY & SCALE] ', '')}</div>
              <div style={{ marginTop: 6, display: 'flex', gap: 9, flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                <span style={{ color: selected.status === 'completed' ? 'var(--color-apex-green)' : 'var(--color-apex-signal)' }}>{selected.status.toUpperCase()}</span>
                <span style={{ color: 'var(--color-apex-muted)' }}>priority {selected.priority}</span>
                <span style={{ color: 'var(--color-apex-muted)' }}>{new Date(selected.createdAt).toLocaleString()}</span>
              </div>
              <div
                style={{
                  marginTop: 12,
                  padding: 13,
                  border: '1px solid var(--color-apex-line)',
                  borderRadius: 6,
                  background: 'rgba(0,0,0,.16)',
                  maxHeight: 380,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  color: 'var(--color-apex-muted)',
                  fontSize: 11,
                  lineHeight: 1.55,
                }}
              >
                {selected.result || 'APEX is still working the cycle. This panel does not invent stage results before the workforce records them.'}
              </div>
            </>
          )}
        </div>

        <div className="glass-card" style={{ padding: isMobile ? 16 : 20, minWidth: 0 }}>
          <div className="apex-eyebrow">Recent cycles</div>
          <div style={{ marginTop: 10, display: 'grid', gap: 7 }}>
            {cycles.slice(0, 8).map((goal) => (
              <button
                key={goal.id}
                onClick={() => setSelectedGoalId(goal.id)}
                style={{
                  textAlign: 'left',
                  border: '1px solid var(--color-apex-line)',
                  borderRadius: 6,
                  padding: 10,
                  background: selected?.id === goal.id ? 'var(--color-apex-brass-soft)' : 'rgba(0,0,0,.12)',
                  color: 'var(--color-apex-text)',
                  cursor: 'pointer',
                  minWidth: 0,
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {goal.title.replace('[VERIFY & SCALE] ', '')}
                </div>
                <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--color-apex-muted)' }}>
                  <span>{goal.status.toUpperCase()}</span>
                  <span>{new Date(goal.createdAt).toLocaleDateString()}</span>
                </div>
              </button>
            ))}
            {cycles.length === 0 && <div style={{ color: 'var(--color-apex-muted)', fontSize: 12 }}>No cycle history yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: ReactNode }) {
  return (
    <div className="glass-card" style={{ padding: '10px 11px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-apex-muted)' }}>
        {icon}
        <span className="apex-eyebrow">{label}</span>
      </div>
      <div style={{ marginTop: 5, fontWeight: 750, fontSize: 13, overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ marginTop: 2, color: 'var(--color-apex-muted)', fontSize: 9 }}>{sub}</div>}
    </div>
  );
}

function EvidenceRow({
  label,
  value,
  ok,
  mono = false,
}: {
  label: string;
  value: string;
  ok: boolean;
  mono?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '18px minmax(90px,.35fr) minmax(0,1fr)', gap: 8, alignItems: 'start', minWidth: 0 }}>
      {ok ? <CheckCircle2 size={15} color="var(--color-apex-green)" /> : <TriangleAlert size={15} color="var(--color-apex-red)" />}
      <span style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>{label}</span>
      <span style={{ fontSize: 10, fontFamily: mono ? 'var(--font-mono)' : undefined, overflowWrap: 'anywhere', color: ok ? 'var(--color-apex-text)' : 'var(--color-apex-red)' }}>
        {value}
      </span>
    </div>
  );
}

function Guard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: 8, alignItems: 'start' }}>
      {ok ? <CheckCircle2 size={16} color="var(--color-apex-green)" /> : <TriangleAlert size={16} color="var(--color-apex-red)" />}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700 }}>{label}</div>
        <div style={{ marginTop: 2, color: 'var(--color-apex-muted)', fontSize: 10, overflowWrap: 'anywhere' }}>{value}</div>
      </div>
    </div>
  );
}
