import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// ─── Translation notes (see plan doc for full rationale) ───────────────────
//
// - Drizzle's `text('id').primaryKey()` / `serial('id')` is dropped in favor
//   of Convex's own `_id`. FK-shaped columns become `v.id("otherTable")`.
// - `createdAt`-only columns (no sibling `updatedAt`, never re-written) are
//   dropped in favor of Convex's `_creationTime` — it's strictly equivalent
//   and one less field to keep in sync. `updatedAt` columns stay explicit
//   `v.number()` since they're mutated after insert, which `_creationTime`
//   cannot be. Business timestamps that aren't "row creation" in spirit
//   (startedAt, completedAt, checkedAt, nextRunAt, etc.) stay explicit too.
// - Convex validators have no `.default(...)`. Every default value the old
//   schema declared (status='idle', tier=0, priority=5, etc.) must be applied
//   by the inserting mutation in convex/*.ts (M2+), not encoded here.
// - `nextRetryAt`/`nextRunAt` are non-optional `v.number()` defaulting to 0
//   (not undefined) at insert time, so a single `.lte()` index range query
//   catches both "never delayed" and "delay elapsed" uniformly.
// - Several tables (agents, projects, applications, scheduledJobs) are
//   upserted-by-known-string today (e.g. 'apex-ceo-001', 'buildmybot2',
//   'system-ceo-goal-review') — Convex's `_id` is opaque and assigned at
//   insert, so it can't hold a human-chosen slug. `legacyId` (indexed) is
//   that stable external key going forward, and doubles as the old-id
//   reference the M7 data-migration importer needs anyway. Added on every
//   table for that same import/audit purpose, even where nothing queries it
//   at runtime today.

export default defineSchema({
  // ─── Agents ────────────────────────────────────────────────────────────
  agents: defineTable({
    legacyId: v.optional(v.string()), // e.g. 'apex-ceo-001' — stable role id, upsert key
    name: v.string(),
    role: v.string(),
    tier: v.number(), // 0=CEO, 1=CTO/COO, 2=Lead, 3=Specialist
    parentId: v.optional(v.id('agents')),
    status: v.union(
      v.literal('idle'),
      v.literal('thinking'),
      v.literal('acting'),
      v.literal('blocked'),
      v.literal('done'),
      v.literal('error'),
    ),
    systemPrompt: v.string(),
    model: v.string(),
    provider: v.string(),
    lastActiveAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_parent', ['parentId'])
    .index('by_role', ['role']),

  // ─── Projects (registry) ───────────────────────────────────────────────
  projects: defineTable({
    legacyId: v.optional(v.string()), // e.g. 'buildmybot2', 'aria' — stable slug, upsert key
    name: v.string(),
    repository: v.optional(v.string()),
    purpose: v.string(),
    priority: v.union(v.literal('critical'), v.literal('high'), v.literal('normal'), v.literal('low')),
    status: v.union(v.literal('active'), v.literal('paused'), v.literal('archived')),
    autonomyLevel: v.union(
      v.literal('manual'),
      v.literal('assisted'),
      v.literal('supervisor'),
      v.literal('full_autonomous'),
      v.literal('experimental'),
    ),
    metadata: v.optional(v.any()),
    updatedAt: v.number(),
  }).index('by_legacyId', ['legacyId']),

  // ─── Goals ─────────────────────────────────────────────────────────────
  goals: defineTable({
    legacyId: v.optional(v.string()),
    projectId: v.optional(v.id('projects')), // null = not yet scoped (legacy/ungrouped)
    title: v.string(),
    description: v.string(),
    status: v.union(v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('cancelled')),
    priority: v.number(), // 1 (highest) – 10 (lowest)
    assignedAgentId: v.optional(v.id('agents')), // always CEO
    completedAt: v.optional(v.number()),
    result: v.optional(v.string()),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_project', ['projectId'])
    .index('by_status', ['status']),

  // ─── Tasks ─────────────────────────────────────────────────────────────
  tasks: defineTable({
    legacyId: v.optional(v.string()),
    goalId: v.optional(v.id('goals')),
    parentTaskId: v.optional(v.id('tasks')),
    title: v.string(),
    description: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('in_progress'),
      v.literal('blocked'),
      v.literal('awaiting_approval'),
      v.literal('done'),
      v.literal('failed'),
      v.literal('cancelled'),
    ),
    priority: v.number(),
    assignedAgentId: v.optional(v.id('agents')),
    createdByAgentId: v.optional(v.id('agents')),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
    nextRetryAt: v.number(), // default 0, not undefined — drives the dequeue index range scan
    retryCount: v.number(),
    maxRetries: v.number(),
    result: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    context: v.optional(v.any()),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_agent_status_retry', ['assignedAgentId', 'status', 'nextRetryAt'])
    .index('by_goal', ['goalId'])
    .index('by_parentTask', ['parentTaskId']),

  // ─── Task Runs (NEW — durable step-wise tool-loop state; see plan §3) ──
  taskRuns: defineTable({
    taskId: v.id('tasks'),
    agentId: v.id('agents'),
    iteration: v.number(),
    history: v.any(), // persisted LLM message array — survives a mid-loop crash/redeploy
    status: v.union(
      v.literal('running'),
      v.literal('awaiting_approval'),
      v.literal('awaiting_external_job'), // one or more tool calls handed to the CI/CD worker
      v.literal('done'),
      v.literal('failed'),
    ),
    // Join state for an iteration that issued >1 tool call where some need an
    // async approval/external-job round-trip: entries here are removed as each
    // resolves, and once empty the iteration's toolResults are assembled and
    // the next LLM turn is scheduled. Pure/DB tool calls never appear here —
    // they resolve synchronously within the same action invocation.
    pendingJoins: v.optional(v.array(v.object({
      toolCallId: v.string(),
      toolName: v.string(),
      args: v.any(), // needed to actually invoke the tool once an approval gating it is granted
      kind: v.union(v.literal('approval'), v.literal('externalJob')),
      refId: v.string(), // approvals._id or externalJobs._id, as a string
    }))),
    partialToolResults: v.optional(v.array(v.any())), // LLMMessage[] collected so far this iteration
    updatedAt: v.number(),
  }).index('by_task', ['taskId']),

  // ─── Approvals ─────────────────────────────────────────────────────────
  approvals: defineTable({
    legacyId: v.optional(v.string()),
    taskId: v.id('tasks'),
    toolCallId: v.string(), // which of the LLM's tool_calls this gates — needed to resume the right one
    agentId: v.id('agents'),
    toolName: v.string(),
    toolArgs: v.any(),
    reason: v.string(),
    status: v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected')),
    reviewedAt: v.optional(v.number()),
    reviewerNote: v.optional(v.string()),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_task', ['taskId'])
    .index('by_status', ['status']),

  // ─── Memory ────────────────────────────────────────────────────────────
  memories: defineTable({
    legacyId: v.optional(v.string()),
    agentId: v.id('agents'),
    scope: v.union(v.literal('agent'), v.literal('project'), v.literal('global')),
    key: v.string(),
    value: v.string(),
    embedding: v.optional(v.array(v.number())),
    importance: v.number(), // 0.0 – 1.0
    tags: v.optional(v.array(v.string())),
    updatedAt: v.number(),
    expiresAt: v.optional(v.number()),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_agent', ['agentId']),

  // ─── Logs ──────────────────────────────────────────────────────────────
  logs: defineTable({
    agentId: v.optional(v.id('agents')),
    taskId: v.optional(v.id('tasks')),
    goalId: v.optional(v.id('goals')),
    level: v.union(
      v.literal('debug'),
      v.literal('info'),
      v.literal('warn'),
      v.literal('error'),
      v.literal('thinking'),
      v.literal('acting'),
    ),
    message: v.string(),
    data: v.optional(v.any()),
    timestamp: v.number(), // explicit epoch ms — kept distinct from _creationTime for import fidelity
  })
    .index('by_agent_time', ['agentId', 'timestamp'])
    .index('by_task_time', ['taskId', 'timestamp']),

  // ─── Messages (inter-agent) ────────────────────────────────────────────
  messages: defineTable({
    legacyId: v.optional(v.string()),
    fromAgentId: v.id('agents'),
    toAgentId: v.id('agents'),
    subject: v.string(),
    body: v.string(),
    replyToId: v.optional(v.id('messages')),
    read: v.boolean(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_to_agent', ['toAgentId'])
    .index('by_from_agent', ['fromAgentId']),

  // ─── Researched Leads ──────────────────────────────────────────────────
  researchedLeads: defineTable({
    legacyId: v.optional(v.string()),
    companyName: v.string(),
    website: v.optional(v.string()), // used for de-dup checks
    industry: v.optional(v.string()),
    city: v.optional(v.string()),
    fitReason: v.string(),
    outreachAngle: v.optional(v.string()),
    status: v.union(v.literal('new'), v.literal('contacted'), v.literal('qualified'), v.literal('rejected')),
    researchedByAgentId: v.id('agents'),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_website', ['website'])
    .index('by_status', ['status']),

  // ─── Health Metrics (time-series) ──────────────────────────────────────
  healthMetrics: defineTable({
    component: v.string(),
    status: v.union(v.literal('healthy'), v.literal('degraded'), v.literal('critical')),
    responseTimeMs: v.optional(v.number()),
    detail: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    checkedAt: v.number(),
  }).index('by_component_time', ['component', 'checkedAt']),

  // ─── Component Health (real-time per-component snapshot) ───────────────
  componentHealth: defineTable({
    component: v.string(), // unique-in-practice — upsert mutation must check first, Convex has no PK constraint
    status: v.union(v.literal('healthy'), v.literal('degraded'), v.literal('critical')),
    detail: v.optional(v.string()),
    lastCheckTime: v.number(),
    consecutiveFailures: v.number(),
    metadata: v.optional(v.any()),
  }).index('by_component', ['component']),

  // ─── Scheduled Jobs ────────────────────────────────────────────────────
  scheduledJobs: defineTable({
    legacyId: v.optional(v.string()), // e.g. 'system-ceo-goal-review' — stable seed-job id
    name: v.string(),
    jobType: v.string(), // 'task_delegation' | 'health_check' | 'report_generation' | 'maintenance' | 'goal_review' | 'learning_analysis'
    cronExpression: v.optional(v.string()),
    scheduledAt: v.optional(v.number()), // for one-time jobs
    enabled: v.boolean(),
    targetAgentId: v.optional(v.id('agents')),
    payload: v.optional(v.any()),
    priority: v.number(),
    status: v.union(v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('failed')),
    retryCount: v.number(),
    maxRetries: v.number(),
    error: v.optional(v.string()),
    nextRunAt: v.number(), // default 0/now, not undefined — drives the due-job index range scan
    lastRunAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_due', ['enabled', 'status', 'nextRunAt']),

  // ─── Job Execution Log ─────────────────────────────────────────────────
  jobExecutionLog: defineTable({
    jobId: v.id('scheduledJobs'),
    executionId: v.string(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    status: v.union(v.literal('running'), v.literal('completed'), v.literal('failed'), v.literal('timeout')),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
  }).index('by_job', ['jobId']),

  // ─── Task Outcomes (learning & analytics) ──────────────────────────────
  taskOutcomes: defineTable({
    taskId: v.id('tasks'),
    agentId: v.id('agents'),
    role: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
    qualityScore: v.number(),
    toolExecutions: v.number(),
    llmCalls: v.number(),
    iterations: v.number(),
    requiredApprovals: v.number(),
    errorType: v.optional(v.string()),
    complexity: v.number(),
    satisfactionMetric: v.number(),
    tags: v.optional(v.array(v.string())),
  })
    .index('by_task', ['taskId'])
    .index('by_agent', ['agentId']),

  // ─── Learning Insights ─────────────────────────────────────────────────
  learningInsights: defineTable({
    legacyId: v.optional(v.string()),
    insightType: v.union(v.literal('pattern'), v.literal('improvement'), v.literal('warning')),
    title: v.string(),
    description: v.string(),
    confidence: v.number(),
    evidence: v.optional(v.any()),
    applied: v.boolean(),
    expiresAt: v.optional(v.number()),
  }).index('by_legacyId', ['legacyId']),

  // ─── Strategy Recommendations ──────────────────────────────────────────
  strategyRecommendations: defineTable({
    legacyId: v.optional(v.string()),
    recommendationType: v.union(
      v.literal('tool_optimization'),
      v.literal('delegation_improvement'),
      v.literal('error_mitigation'),
    ),
    title: v.string(),
    text: v.string(),
    expectedImpact: v.string(),
    confidence: v.number(),
    status: v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected'), v.literal('applied')),
    reviewedAt: v.optional(v.number()),
    reviewerNote: v.optional(v.string()),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_status', ['status']),

  // ─── Performance Baselines ─────────────────────────────────────────────
  performanceBaselines: defineTable({
    metricName: v.string(), // unique-in-practice — upsert mutation must check first
    baselineValue: v.number(),
    measurementWindow: v.string(),
    sampleSize: v.number(),
    validUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index('by_metricName', ['metricName']),

  // ─── Pipeline Runs ─────────────────────────────────────────────────────
  pipelineRuns: defineTable({
    legacyId: v.optional(v.string()),
    repo: v.string(),
    branch: v.string(),
    commitSha: v.optional(v.string()),
    status: v.union(v.literal('running'), v.literal('success'), v.literal('failed'), v.literal('cancelled')),
    triggerType: v.union(v.literal('manual'), v.literal('scheduled'), v.literal('webhook')),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_status', ['status']),

  // ─── Test Results ──────────────────────────────────────────────────────
  testResults: defineTable({
    runId: v.string(),
    totalTests: v.number(),
    passed: v.number(),
    failed: v.number(),
    skipped: v.number(),
    durationMs: v.number(),
    coveragePct: v.optional(v.number()),
    testReport: v.optional(v.any()),
  }).index('by_run', ['runId']),

  // ─── Lint Results ──────────────────────────────────────────────────────
  lintResults: defineTable({
    runId: v.string(),
    totalFiles: v.number(),
    errors: v.number(),
    warnings: v.number(),
    lintReport: v.optional(v.any()),
  }).index('by_run', ['runId']),

  // ─── Deployments ───────────────────────────────────────────────────────
  deployments: defineTable({
    legacyId: v.optional(v.string()),
    runId: v.optional(v.string()),
    environment: v.union(v.literal('staging'), v.literal('production')),
    platform: v.union(v.literal('railway'), v.literal('vercel'), v.literal('local')),
    deploymentUrl: v.optional(v.string()),
    status: v.union(
      v.literal('pending'),
      v.literal('deploying'),
      v.literal('healthy'),
      v.literal('degraded'),
      v.literal('failed'),
      v.literal('rolled_back'),
    ),
    rolledBack: v.boolean(),
    error: v.optional(v.string()),
    deployedAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_status', ['status']),

  // ─── Portfolio Applications ────────────────────────────────────────────
  applications: defineTable({
    legacyId: v.optional(v.string()), // e.g. 'buildmybot2' — stable upsert key
    name: v.string(),
    repoUrl: v.string(),
    status: v.union(v.literal('active'), v.literal('degraded'), v.literal('inactive')),
    healthScore: v.number(),
    lastSyncAt: v.number(),
  }).index('by_legacyId', ['legacyId']),

  // ─── Application Tasks ─────────────────────────────────────────────────
  applicationTasks: defineTable({
    appId: v.id('applications'),
    taskName: v.string(),
    status: v.union(v.literal('pending'), v.literal('in_progress'), v.literal('completed'), v.literal('failed')),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  }).index('by_app', ['appId']),

  // ─── Predictive Forecasts ──────────────────────────────────────────────
  predictiveForecasts: defineTable({
    legacyId: v.optional(v.string()),
    metricName: v.string(),
    forecastValue: v.number(),
    confidence: v.number(),
    window: v.string(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_metricName', ['metricName']),

  // ─── Risk Assessments ──────────────────────────────────────────────────
  riskAssessments: defineTable({
    legacyId: v.optional(v.string()),
    target: v.string(),
    riskLevel: v.union(v.literal('low'), v.literal('medium'), v.literal('high'), v.literal('critical')),
    details: v.string(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_target', ['target']),

  // ─── Alerts (M4 — persistent AlertManager state; Convex crons have no
  // in-memory process to hold this between invocations, unlike the old
  // long-lived AlertManager instance) ─────────────────────────────────────
  alerts: defineTable({
    rule: v.string(), // e.g. 'component_critical' — one row per currently-firing rule
    severity: v.union(v.literal('warning'), v.literal('critical')),
    message: v.string(),
    component: v.string(),
    firedAt: v.number(),
    acknowledgedAt: v.optional(v.number()),
  })
    .index('by_rule', ['rule'])
    .index('by_acknowledged', ['acknowledgedAt']),

  // ─── Integration Settings (server-side persisted API keys) ────────────
  integrationSettings: defineTable({
    key: v.string(), // env var name, e.g. 'GROQ_API_KEY' — unique-in-practice
    value: v.string(), // write-only from the API's perspective; GET endpoints return configured:boolean only
    updatedBy: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  // ─── External Jobs (NEW — CI/CD worker contract; see plan §4) ─────────
  externalJobs: defineTable({
    jobType: v.union(
      v.literal('test'),
      v.literal('lint'),
      v.literal('build'),
      v.literal('deploy'),
      v.literal('rollback'),
      v.literal('git_status'),
      v.literal('create_branch'),
      v.literal('push'),
      v.literal('create_pr'),
      v.literal('run_shell'),
      v.literal('read_file'),
      v.literal('write_file'),
      v.literal('list_dir'),
      v.literal('run_sandbox'),
      v.literal('browser_check'),
    ),
    status: v.union(
      v.literal('queued'),
      v.literal('claimed'),
      v.literal('running'),
      v.literal('succeeded'),
      v.literal('failed'),
    ),
    payload: v.any(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    requestingTaskId: v.optional(v.id('tasks')),
    requestingAgentId: v.optional(v.id('agents')),
    toolCallId: v.optional(v.string()), // links back to the taskRuns.pendingJoins entry awaiting this job
    claimedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    timeoutAt: v.number(),
  })
    .index('by_status', ['status'])
    .index('by_timeout', ['status', 'timeoutAt']),
});
