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
  createdAt: number;
  completedAt: number | null;
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
  },

  logs: {
    list: (limit?: number) =>
      apiFetch<{ logs: LogEntry[] }>(`/logs${limit ? `?limit=${limit}` : ''}`).then((r) => r.logs),
  },

  approvals: {
    list: (status?: string) =>
      apiFetch<{ approvals: Approval[] }>(`/approvals${status ? `?status=${status}` : ''}`).then((r) => r.approvals),
    approve: (id: string, note?: string) =>
      apiFetch(`/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
    reject: (id: string, note?: string) =>
      apiFetch(`/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  },

  tools: {
    list: () => apiFetch<{ tools: ToolInfo[] }>('/tools').then((r) => r.tools),
    invoke: (name: string, args: Record<string, unknown>) =>
      apiFetch<unknown>(`/tools/${name}`, { method: 'POST', body: JSON.stringify(args) }),
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
    analyze: () => apiFetch<{ success: boolean; patternsCreated: number }>('/learning/analyze', { method: 'POST' }),
    baselines: () => apiFetch<PerformanceBaselineRow[]>('/learning/baselines'),
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
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
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
  lastActiveAt: number | null;
}

export interface Memory {
  id: string;
  agentId: string;
  scope: string;
  key: string;
  value: string;
  importance: number;
  tags: string[] | null;
  createdAt: number;
}

export interface LogEntry {
  id: number;
  agentId: string | null;
  taskId: string | null;
  level: string;
  message: string;
  timestamp: number;
}

export interface Approval {
  id: string;
  taskId: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  status: string;
  createdAt: number;
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


