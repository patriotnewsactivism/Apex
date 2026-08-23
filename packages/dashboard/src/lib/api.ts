const API = '/api';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('apex_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers as Record<string, string>,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Goals ────────────────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  assignedAgentId: string | null;
  createdAt: string;
  completedAt: string | null;
  result: string | null;
}

export const api = {
  goals: {
    list: () => apiFetch<{ goals: Goal[] }>('/goals').then((r) => r.goals),
    get: (id: string) => apiFetch<{ goal: Goal }>(`/goals/${id}`).then((r) => r.goal),
    submit: (data: { title: string; description: string; priority?: number }) =>
      apiFetch<{ goalId: string }>('/goals', { method: 'POST', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) =>
      apiFetch(`/goals/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  },

  tasks: {
    list: (params?: { status?: string; agentId?: string; goalId?: string }) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString();
      return apiFetch<{ tasks: Task[] }>(`/tasks${qs ? `?${qs}` : ''}`).then((r) => r.tasks);
    },
    get: (id: string) => apiFetch<{ task: Task }>(`/tasks/${id}`).then((r) => r.task),
    update: (id: string, data: Partial<Task>) =>
      apiFetch(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  },

  agents: {
    list: () => apiFetch<{ agents: Agent[] }>('/agents').then((r) => r.agents),
    get: (id: string) => apiFetch<{ agent: Agent }>(`/agents/${id}`).then((r) => r.agent),
    memory: (id: string) => apiFetch<{ memories: Memory[] }>(`/agents/${id}/memory`).then((r) => r.memories),
    reconfigure: (id: string, data: { concurrency?: number; maxIterations?: number }) =>
      apiFetch<{ success: boolean; applied: Record<string, unknown> }>(`/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  logs: {
    list: (limit?: number) =>
      apiFetch<{ logs: LogEntry[] }>(`/logs${limit ? `?limit=${limit}` : ''}`).then((r) => r.logs),
  },

  approvals: {
    // kind defaults server-side to 'approval' — gated calls where an agent is
    // actually blocked. Pass 'escalation' for the ask-Don messages.
    list: (status = 'pending', kind: ApprovalKind = 'approval') =>
      apiFetch<{ approvals: Approval[] }>(
        `/approvals?status=${encodeURIComponent(status)}&kind=${encodeURIComponent(kind)}`,
      ).then((r) => r.approvals),
    counts: () => apiFetch<{ approval: number; escalation: number }>('/approvals/counts'),
    approve: (id: string, note?: string) =>
      apiFetch(`/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
    reject: (id: string, note?: string) =>
      apiFetch(`/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
    acknowledge: (id: string, note?: string) =>
      apiFetch(`/approvals/${id}/acknowledge`, { method: 'POST', body: JSON.stringify({ note }) }),
  },

  campaigns: {
    list: () => apiFetch<{ campaigns: CampaignProgress[] }>('/campaigns').then((r) => r.campaigns),
    get: (id: string) =>
      apiFetch<{ campaign: CampaignProgress & { icp: CampaignIcp; result: string | null }; segments: CampaignSegment[] }>(
        `/campaigns/${id}`,
      ),
    leads: (id: string) =>
      apiFetch<{ leads: ResearchedLead[] }>(`/campaigns/${id}/leads`).then((r) => r.leads),
    create: (body: {
      name: string;
      industries: string[];
      cities: string[];
      targetLeads?: number;
      pushToBuildmybot?: boolean;
      notes?: string;
    }) => apiFetch<{ campaignId: string; segments: number }>('/campaigns', { method: 'POST', body: JSON.stringify(body) }),
    control: (id: string, action: 'pause' | 'resume' | 'cancel') =>
      apiFetch<{ status: string }>(`/campaigns/${id}/${action}`, { method: 'POST' }),
  },

  tools: {
    list: () => apiFetch<{ tools: ToolInfo[] }>('/tools').then((r) => r.tools),
    invoke: (name: string, args: Record<string, unknown>) =>
      apiFetch<unknown>(`/tools/${name}`, { method: 'POST', body: JSON.stringify(args) }),
  },

  settings: {
    // Never returns plaintext values — status only (configured: boolean).
    listIntegrations: () =>
      apiFetch<{ integrations: { key: string; configured: boolean }[] }>('/settings/integrations').then((r) => r.integrations),
    saveIntegration: (key: string, value: string) =>
      apiFetch<{ ok: boolean; key: string; configured: boolean }>('/settings/integrations', {
        method: 'POST',
        body: JSON.stringify({ key, value }),
      }),
    clearIntegration: (key: string) =>
      apiFetch<{ ok: boolean; key: string; configured: boolean }>(`/settings/integrations/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      }),
  },

  health: {
    report: () => apiFetch<HealthReport>('/health'),
    components: () => apiFetch<ComponentHealthRow[]>('/health/components'),
    alerts: () => apiFetch<{ alerts: HealthAlert[]; summary: AlertSummary }>('/health/alerts'),
    acknowledge: (alertId: string) =>
      apiFetch(`/health/alerts/${alertId}/acknowledge`, { method: 'POST' }),
  },

  jobs: {
    list: () => apiFetch<ScheduledJobRow[]>('/jobs'),
    create: (data: { name: string; jobType: string; cronExpression?: string; scheduledAt?: string; targetAgentId?: string; payload?: Record<string, unknown>; priority?: number }) =>
      apiFetch<ScheduledJobRow>('/jobs', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { cronExpression?: string; payload?: Record<string, unknown>; priority?: number; enabled?: boolean }) =>
      apiFetch<ScheduledJobRow>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    toggle: (id: string) => apiFetch<ScheduledJobRow>(`/jobs/${id}/toggle`, { method: 'POST' }),
    remove: (id: string) => apiFetch(`/jobs/${id}`, { method: 'DELETE' }),
    history: (id: string) => apiFetch<JobExecutionRow[]>(`/jobs/${id}/history`),
  },

  learning: {
    outcomes: (role?: string) => apiFetch<TaskOutcomeRow[]>(`/learning/outcomes${role ? `?role=${role}` : ''}`),
    insights: () => apiFetch<LearningInsightRow[]>('/learning/insights'),
    recommendations: (status?: string) => apiFetch<StrategyRecommendationRow[]>(`/learning/recommendations${status ? `?status=${status}` : ''}`),
    respondRecommendation: (id: string, action: 'approve' | 'reject') =>
      apiFetch(`/learning/recommendations/${id}/respond`, { method: 'POST', body: JSON.stringify({ action }) }),
    applyRecommendation: (id: string) =>
      apiFetch<{ success: boolean; status: string; changes: Record<string, unknown> }>(`/learning/recommendations/${id}/apply`, { method: 'POST' }),
    analyze: () => apiFetch<{ success: boolean; patternsCreated: number }>('/learning/analyze', { method: 'POST' }),
    baselines: () => apiFetch<PerformanceBaselineRow[]>('/learning/baselines'),
  },

  cicd: {
    status: () => apiFetch<CicdStatusSummary>('/cicd/status'),
    runTest: () => apiFetch<TestRunReportRow>('/cicd/test', { method: 'POST' }),
    runLint: () => apiFetch<LintRunReportRow>('/cicd/lint', { method: 'POST' }),
    build: () => apiFetch<BuildResultRow>('/cicd/build', { method: 'POST' }),
    deploy: (environment?: string, platform?: string) =>
      apiFetch<DeploymentRow>('/cicd/deploy', { method: 'POST', body: JSON.stringify({ environment, platform }) }),
    rollback: (deploymentId: string) =>
      apiFetch<{ success: boolean; rolledBackId: string }>('/cicd/rollback', { method: 'POST', body: JSON.stringify({ deploymentId }) }),
    history: () => apiFetch<PipelineRunRow[]>('/cicd/history'),
  },

  multiapp: {
    list: () => apiFetch<ApplicationRow[]>('/applications'),
    register: (id: string, name: string, repoUrl: string) =>
      apiFetch<{ success: boolean }>('/applications', { method: 'POST', body: JSON.stringify({ id, name, repoUrl }) }),
    health: (id: string) => apiFetch<{ status: string; healthScore: number }>(`/applications/${id}/health`),
    delegate: (id: string, taskName: string) =>
      apiFetch<{ taskId: number; appId: string }>(`/applications/${id}/delegate`, { method: 'POST', body: JSON.stringify({ taskName }) }),
    sharedInsights: () => apiFetch<Array<{ id: string; key: string; value: string }>>('/applications/shared-insights'),
  },

  predictive: {
    forecast: () => apiFetch<PredictiveForecastRow>('/predictive/tasks-forecast'),
    risks: () => apiFetch<{ latestAssessment: RiskAssessmentRow; riskHistory: RiskAssessmentRow[] }>('/predictive/risks'),
  },

  leads: {
    list: (params?: { status?: string; industry?: string; city?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.industry) qs.set('industry', params.industry);
      if (params?.city) qs.set('city', params.city);
      if (params?.limit) qs.set('limit', String(params.limit));
      const query = qs.toString();
      return apiFetch<{ leads: ResearchedLead[] }>(`/leads${query ? `?${query}` : ''}`).then((r) => r.leads);
    },
    stats: () => apiFetch<LeadStats>('/leads/stats'),
    exportCsv: () => {
      const token = localStorage.getItem('apex_token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return fetch(`${API}/leads/export`, { headers }).then((r) => r.blob());
    },
    updateStatus: (id: string, status: string) =>
      apiFetch(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  },

  suggestions: {
    list: () => apiFetch<{ suggestions: SuggestionRow[] }>('/suggestions').then((r) => r.suggestions),
    implement: (id: string, data: { goalTitle: string; goalDescription: string; goalPriority: number }) =>
      apiFetch<{ success: boolean; goalId: string }>(`/suggestions/${id}/implement`, { method: 'POST', body: JSON.stringify(data) }),
  },

  system: {
    get: () => apiFetch<{ settings: Record<string, string> }>('/settings/system'),
    update: (data: { autonomy_level?: string }) =>
      apiFetch<{ ok: boolean }>('/settings/system', { method: 'PUT', body: JSON.stringify(data) }),
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  goalId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: string;
  priority: number;
  assignedAgentId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: string | null;
  errorMessage: string | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  tier: number;
  parentId: string | null;
  status: string;
  liveStatus?: string;
  model: string;
  provider: string;
  lastActiveAt: string | null;
  concurrency?: number;
  maxIterations?: number;
  metadata?: Record<string, unknown> | null;
}

export interface Memory {
  id: string;
  agentId: string;
  scope: string;
  key: string;
  value: string;
  importance: number;
  tags: string[] | null;
  createdAt: string;
}

export interface LogEntry {
  id: number;
  agentId: string | null;
  taskId: string | null;
  level: string;
  message: string;
  timestamp: string;
}

export type ApprovalKind = 'approval' | 'escalation' | 'all';

export interface Approval {
  id: string;
  taskId: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  status: string;
  createdAt: string;
  /** 'approval' = a gated tool call, an agent is blocked.
   *  'escalation' = escalate_to_human, a message asking for a decision. */
  kind?: string;
  /** How many times this same escalation has been re-raised. */
  occurrences?: number;
  lastOccurredAt?: string | null;
}

export interface CampaignIcp {
  industries: string[];
  cities: string[];
  notes?: string;
}

export interface CampaignProgress {
  campaignId: string;
  name: string;
  status: string;
  /** What to render. 'stalled' is derived from lastProgressAt, not stored —
   *  a campaign whose runner died still reads as 'running' in the table. */
  displayStatus: string;
  targetLeads: number;
  leadsSaved: number;
  leadProgress: number;
  segmentsTotal: number;
  segmentsDone: number;
  segmentsFailed: number;
  segmentsRemaining: number;
  coverage: number;
  duplicatesSkipped: number;
  /** null until a segment completes — never a fabricated zero. */
  yieldPerSegment: number | null;
  etaMs: number | null;
  lastProgressAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CampaignSegment {
  id: string;
  campaignId: string;
  industry: string;
  city: string;
  status: string;
  found: number;
  saved: number;
  duplicates: number;
  attempts: number;
  lastError: string | null;
}

export interface ToolInfo {
  name: string;
  description: string;
  requiresApproval: boolean;
}

// ─── Health Types ─────────────────────────────────────────────────────────────

export interface ComponentCheck {
  status: 'healthy' | 'degraded' | 'critical';
  detail: string;
  ms?: number;
}

export interface HealthReport {
  overall: 'healthy' | 'degraded' | 'critical';
  checks: Record<string, ComponentCheck>;
  timestamp: string;
}

export interface ComponentHealthRow {
  component: string;
  status: string;
  detail: string | null;
  lastCheckTime: string;
  consecutiveFailures: number;
}

export interface HealthAlert {
  id: string;
  rule: string;
  severity: 'warning' | 'critical';
  message: string;
  component: string;
  firedAt: string;
  acknowledgedAt?: string;
}

export interface AlertSummary {
  total: number;
  critical: number;
  warning: number;
  acknowledged: number;
}

// ─── Job Types ────────────────────────────────────────────────────────────────

export interface ScheduledJobRow {
  id: string;
  name: string;
  jobType: string;
  cronExpression: string | null;
  scheduledAt: string | null;
  enabled: boolean;
  targetAgentId: string | null;
  payload: Record<string, unknown> | null;
  priority: number;
  status: string;
  retryCount: number;
  maxRetries: number;
  error: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobExecutionRow {
  id: number;
  jobId: string;
  executionId: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: string;
  output: string | null;
  error: string | null;
}

// ─── Learning Types ───────────────────────────────────────────────────────────

export interface TaskOutcomeRow {
  id: number;
  taskId: string;
  agentId: string;
  role: string;
  durationMs: number;
  success: boolean;
  qualityScore: number;
  toolExecutions: number;
  llmCalls: number;
  iterations: number;
  requiredApprovals: number;
  errorType: string | null;
  complexity: number;
  satisfactionMetric: number;
  tags: string[] | null;
  recordedAt: string;
}

export interface LearningInsightRow {
  id: string;
  insightType: 'pattern' | 'improvement' | 'warning';
  title: string;
  description: string;
  confidence: number;
  evidence: Record<string, unknown> | null;
  applied: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface StrategyRecommendationRow {
  id: string;
  recommendationType: string;
  title: string;
  text: string;
  expectedImpact: string;
  confidence: number;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  reviewedAt: string | null;
  reviewerNote: string | null;
  createdAt: string;
}

export interface PerformanceBaselineRow {
  metricName: string;
  baselineValue: number;
  measurementWindow: string;
  sampleSize: number;
  validUntil: string | null;
  updatedAt: string;
}

// ─── CI/CD Types ──────────────────────────────────────────────────────────────

export interface PipelineRunRow {
  id: string;
  repo: string;
  branch: string;
  commitSha: string | null;
  status: string;
  triggerType: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface TestRunReportRow {
  id: number;
  runId: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  coveragePct: number | null;
  testReport: Record<string, unknown> | null;
  recordedAt: string;
}

export interface LintRunReportRow {
  id: number;
  runId: string;
  totalFiles: number;
  errors: number;
  warnings: number;
  lintReport: Record<string, unknown> | null;
  recordedAt: string;
}

export interface DeploymentRow {
  id: string;
  runId: string | null;
  environment: string;
  platform: string;
  deploymentUrl: string | null;
  status: string;
  rolledBack: boolean;
  error: string | null;
  deployedAt: string;
}

export interface BuildResultRow {
  runId: string;
  success: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

export interface CicdStatusSummary {
  latestRun: PipelineRunRow | null;
  latestTest: TestRunReportRow | null;
  latestLint: LintRunReportRow | null;
  deployments: DeploymentRow[];
}

// ─── MultiApp & Predictive Types ──────────────────────────────────────────────

export interface ApplicationRow {
  id: string;
  name: string;
  repoUrl: string;
  status: string;
  healthScore: number;
  lastSyncAt: string;
  createdAt: string;
}

export interface PredictiveForecastRow {
  id: string;
  metricName: string;
  forecastValue: number;
  confidence: number;
  window: string;
  createdAt: string;
}

export interface RiskAssessmentRow {
  id: string;
  target: string;
  riskLevel: string;
  details: string;
  createdAt: string;
}

// ─── Leads Types ───────────────────────────────────────────────────────────

export interface ResearchedLead {
  id: string;
  companyName: string;
  website: string | null;
  industry: string | null;
  city: string | null;
  fitReason: string;
  outreachAngle: string | null;
  status: string;
  researchedByAgentId: string;
  createdAt: string;
}

export interface LeadStats {
  total: number;
  byStatus: { new: number; contacted: number; qualified: number; rejected: number };
  byIndustry: Record<string, number>;
}

export interface SuggestionRow {
  id: string;
  title: string;
  description: string;
  category: 'self_improvement' | 'app_improvement';
  impact: 'high' | 'medium' | 'low';
  difficulty: 'easy' | 'medium' | 'hard';
  goalTitle: string;
  goalDescription: string;
  goalPriority: number;
}




