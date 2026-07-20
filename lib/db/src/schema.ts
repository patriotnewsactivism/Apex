import { pgTable, text, integer, real, timestamp, jsonb, boolean, serial } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── Agents ──────────────────────────────────────────────────────────────────

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(), // CEO | CTO | COO | LEAD_DEV | FRONTEND | BACKEND | DEVOPS | QA | RESEARCH | DOCS | OPS
  tier: integer('tier').notNull().default(0), // 0=CEO, 1=CTO/COO, 2=Lead, 3=Specialist
  parentId: text('parent_id'),
  status: text('status').notNull().default('idle'), // idle | thinking | acting | blocked | done | error
  systemPrompt: text('system_prompt').notNull(),
  model: text('model').notNull().default('gpt-4o'),
  provider: text('provider').notNull().default('openai'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
});

// ─── Projects (registry) ───────────────────────────────────────────────────
//
// Added 2026-07-18 as part of the Apex reframe: Apex is the autonomous
// operating system for ALL of Don's ventures, not just BuildMyBot. Every
// project Apex can operate on gets a row here. goals.projectId (nullable,
// added below) scopes a goal to one of these — null means "not yet scoped"
// (legacy/ungrouped goals), not "global/none".

export const projects = pgTable('projects', {
  id: text('id').primaryKey(), // slug, e.g. 'buildmybot', 'aria', 'codeforge-v2'
  name: text('name').notNull(),
  repository: text('repository'), // e.g. 'patriotnewsactivism/buildmybot2'
  purpose: text('purpose').notNull(),
  priority: text('priority').notNull().default('normal'), // critical | high | normal | low
  status: text('status').notNull().default('active'), // active | paused | archived
  autonomyLevel: text('autonomy_level').notNull().default('supervisor'), // manual | assisted | supervisor | full_autonomous | experimental
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Goals ───────────────────────────────────────────────────────────────────

export const goals = pgTable('goals', {
  id: text('id').primaryKey(),
  projectId: text('project_id'), // FK -> projects.id, nullable for legacy/ungrouped goals
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull().default('active'), // active | paused | completed | cancelled
  priority: integer('priority').notNull().default(5), // 1 (highest) – 10 (lowest)
  assignedAgentId: text('assigned_agent_id'), // always CEO
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  result: text('result'),
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  goalId: text('goal_id'),
  parentTaskId: text('parent_task_id'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull().default('pending'), // pending | in_progress | blocked | awaiting_approval | done | failed | cancelled
  priority: integer('priority').notNull().default(5),
  assignedAgentId: text('assigned_agent_id'),
  createdByAgentId: text('created_by_agent_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(3),
  result: text('result'),
  errorMessage: text('error_message'),
  context: jsonb('context').$type<Record<string, unknown>>(),
});

// ─── Approvals ────────────────────────────────────────────────────────────────

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  agentId: text('agent_id').notNull(),
  toolName: text('tool_name').notNull(),
  toolArgs: jsonb('tool_args').$type<Record<string, unknown>>().notNull(),
  reason: text('reason').notNull(), // why agent wants to run this tool
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  reviewerNote: text('reviewer_note'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Memory ───────────────────────────────────────────────────────────────────

export const memories = pgTable('memories', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  scope: text('scope').notNull().default('agent'), // agent | project | global
  key: text('key').notNull(),
  value: text('value').notNull(),
  embedding: jsonb('embedding').$type<number[]>(),
  importance: real('importance').notNull().default(0.5), // 0.0 – 1.0
  tags: jsonb('tags').$type<string[]>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

export const logs = pgTable('logs', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id'),
  taskId: text('task_id'),
  goalId: text('goal_id'),
  level: text('level').notNull().default('info'), // debug | info | warn | error | thinking | acting
  message: text('message').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
  timestamp: timestamp('timestamp', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Messages (inter-agent) ───────────────────────────────────────────────────

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  fromAgentId: text('from_agent_id').notNull(),
  toAgentId: text('to_agent_id').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  replyToId: text('reply_to_id'),
  read: boolean('read').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Researched Leads (Lead Research Agent output) ────────────────────────────

export const researchedLeads = pgTable('researched_leads', {
  id: text('id').primaryKey(),
  companyName: text('company_name').notNull(),
  website: text('website'), // used for de-dup checks
  industry: text('industry'),
  city: text('city'),
  fitReason: text('fit_reason').notNull(), // why it matches the ICP pain point
  outreachAngle: text('outreach_angle'),
  status: text('status').notNull().default('new'), // new | contacted | qualified | rejected
  researchedByAgentId: text('researched_by_agent_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Health Metrics (time-series) ─────────────────────────────────────────────

export const healthMetrics = pgTable('health_metrics', {
  id: serial('id').primaryKey(),
  component: text('component').notNull(),          // 'database' | 'llmProviders' | 'memorySystem' | 'toolRegistry' | 'webSocket' | 'taskBacklog'
  status: text('status').notNull(),                 // 'healthy' | 'degraded' | 'critical'
  responseTimeMs: integer('response_time_ms'),
  detail: text('detail'),
  errorMessage: text('error_message'),
  checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Component Health (real-time per-component snapshot) ──────────────────────

export const componentHealth = pgTable('component_health', {
  component: text('component').primaryKey(),        // same keys as healthMetrics.component
  status: text('status').notNull().default('healthy'),
  detail: text('detail'),
  lastCheckTime: timestamp('last_check_time', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
});

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────

export const scheduledJobs = pgTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  jobType: text('job_type').notNull(),              // 'task_delegation' | 'health_check' | 'report_generation' | 'maintenance'
  cronExpression: text('cron_expression'),           // standard 5-part cron, null = one-time
  scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }),  // for one-time jobs
  enabled: boolean('enabled').notNull().default(true),
  targetAgentId: text('target_agent_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  priority: integer('priority').notNull().default(5),
  status: text('status').notNull().default('active'), // active | paused | completed | failed
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(3),
  error: text('error'),
  nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Job Execution Log ────────────────────────────────────────────────────────

export const jobExecutionLog = pgTable('job_execution_log', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull(),
  executionId: text('execution_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  durationMs: integer('duration_ms'),
  status: text('status').notNull().default('running'), // running | completed | failed | timeout
  output: text('output'),
  error: text('error'),
});

// ─── Task Outcomes (learning & analytics) ──────────────────────────────────────

export const taskOutcomes = pgTable('task_outcomes', {
  id: serial('id').primaryKey(),
  taskId: text('task_id').notNull(),
  agentId: text('agent_id').notNull(),
  role: text('role').notNull(),
  durationMs: integer('duration_ms').notNull(),
  success: boolean('success').notNull(),
  qualityScore: real('quality_score').notNull().default(1.0),
  toolExecutions: integer('tool_executions').notNull().default(0),
  llmCalls: integer('llm_calls').notNull().default(0),
  iterations: integer('iterations').notNull().default(1),
  requiredApprovals: integer('required_approvals').notNull().default(0),
  errorType: text('error_type'),
  complexity: real('complexity').notNull().default(0.5),
  satisfactionMetric: real('satisfaction_metric').notNull().default(1.0),
  tags: jsonb('tags').$type<string[]>(),
  recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Learning Insights ────────────────────────────────────────────────────────

export const learningInsights = pgTable('learning_insights', {
  id: text('id').primaryKey(),
  insightType: text('insight_type').notNull(), // 'pattern' | 'improvement' | 'warning'
  title: text('title').notNull(),
  description: text('description').notNull(),
  confidence: real('confidence').notNull().default(0.8), // 0.0 – 1.0
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  applied: boolean('applied').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
});

// ─── Strategy Recommendations ─────────────────────────────────────────────────

export const strategyRecommendations = pgTable('strategy_recommendations', {
  id: text('id').primaryKey(),
  recommendationType: text('recommendation_type').notNull(), // 'tool_optimization' | 'delegation_improvement' | 'error_mitigation'
  title: text('title').notNull(),
  text: text('text').notNull(),
  expectedImpact: text('expected_impact').notNull(),
  confidence: real('confidence').notNull().default(0.8),
  status: text('status').notNull().default('pending'), // pending | approved | rejected | applied
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  reviewerNote: text('reviewer_note'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Performance Baselines ───────────────────────────────────────────────────

export const performanceBaselines = pgTable('performance_baselines', {
  metricName: text('metric_name').primaryKey(), // e.g. 'avg_task_duration_ms', 'overall_success_rate'
  baselineValue: real('baseline_value').notNull(),
  measurementWindow: text('measurement_window').notNull().default('30d'),
  sampleSize: integer('sample_size').notNull().default(0),
  validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Pipeline Runs ─────────────────────────────────────────────────────────────

export const pipelineRuns = pgTable('pipeline_runs', {
  id: text('id').primaryKey(),
  repo: text('repo').notNull().default('Apex'),
  branch: text('branch').notNull().default('main'),
  commitSha: text('commit_sha'),
  status: text('status').notNull().default('running'), // running | success | failed | cancelled
  triggerType: text('trigger_type').notNull().default('manual'), // manual | scheduled | webhook
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  durationMs: integer('duration_ms'),
  error: text('error'),
});

// ─── Test Results ─────────────────────────────────────────────────────────────

export const testResults = pgTable('test_results', {
  id: serial('id').primaryKey(),
  runId: text('run_id').notNull(),
  totalTests: integer('total_tests').notNull().default(0),
  passed: integer('passed').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  coveragePct: real('coverage_pct'),
  testReport: jsonb('test_report').$type<Record<string, unknown>>(),
  recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Lint Results ─────────────────────────────────────────────────────────────

export const lintResults = pgTable('lint_results', {
  id: serial('id').primaryKey(),
  runId: text('run_id').notNull(),
  totalFiles: integer('total_files').notNull().default(0),
  errors: integer('errors').notNull().default(0),
  warnings: integer('warnings').notNull().default(0),
  lintReport: jsonb('lint_report').$type<Record<string, unknown>>(),
  recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Deployments ──────────────────────────────────────────────────────────────

export const deployments = pgTable('deployments', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  environment: text('environment').notNull().default('production'), // staging | production
  platform: text('platform').notNull().default('railway'), // railway | vercel | local
  deploymentUrl: text('deployment_url'),
  status: text('status').notNull().default('pending'), // pending | deploying | healthy | degraded | failed | rolled_back
  rolledBack: boolean('rolled_back').notNull().default(false),
  error: text('error'),
  deployedAt: timestamp('deployed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Portfolio Applications ───────────────────────────────────────────────────

export const applications = pgTable('applications', {
  id: text('id').primaryKey(), // e.g. 'buildmybot2', 'aria', 'autonomous-coder'
  name: text('name').notNull(),
  repoUrl: text('repo_url').notNull(),
  status: text('status').notNull().default('active'), // active | degraded | inactive
  healthScore: real('health_score').notNull().default(1.0),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Application Tasks ────────────────────────────────────────────────────────

export const applicationTasks = pgTable('application_tasks', {
  id: serial('id').primaryKey(),
  appId: text('app_id').notNull(),
  taskName: text('task_name').notNull(),
  status: text('status').notNull().default('pending'), // pending | in_progress | completed | failed
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
});

// ─── Predictive Forecasts ─────────────────────────────────────────────────────

export const predictiveForecasts = pgTable('predictive_forecasts', {
  id: text('id').primaryKey(),
  metricName: text('metric_name').notNull(),
  forecastValue: real('forecast_value').notNull(),
  confidence: real('confidence').notNull().default(0.8),
  window: text('window').notNull().default('7d'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Risk Assessments ─────────────────────────────────────────────────────────

export const riskAssessments = pgTable('risk_assessments', {
  id: text('id').primaryKey(),
  target: text('target').notNull(),
  riskLevel: text('risk_level').notNull(), // low | medium | high | critical
  details: text('details').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ─── Relations ────────────────────────────────────────────────────────────────

export const agentRelations = relations(agents, ({ one, many }) => ({
  parent: one(agents, { fields: [agents.parentId], references: [agents.id] }),
  children: many(agents),
  tasks: many(tasks),
  memories: many(memories),
  logs: many(logs),
  sentMessages: many(messages, { relationName: 'sentMessages' }),
  receivedMessages: many(messages, { relationName: 'receivedMessages' }),
}));

export const projectRelations = relations(projects, ({ many }) => ({
  goals: many(goals),
}));

export const goalRelations = relations(goals, ({ many, one }) => ({
  tasks: many(tasks),
  assignedAgent: one(agents, { fields: [goals.assignedAgentId], references: [agents.id] }),
  project: one(projects, { fields: [goals.projectId], references: [projects.id] }),
}));

export const taskRelations = relations(tasks, ({ one, many }) => ({
  goal: one(goals, { fields: [tasks.goalId], references: [goals.id] }),
  parent: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id] }),
  children: many(tasks),
  assignedAgent: one(agents, { fields: [tasks.assignedAgentId], references: [agents.id] }),
  logs: many(logs),
  approvals: many(approvals),
}));

export const memoryRelations = relations(memories, ({ one }) => ({
  agent: one(agents, { fields: [memories.agentId], references: [agents.id] }),
}));

export const logRelations = relations(logs, ({ one }) => ({
  agent: one(agents, { fields: [logs.agentId], references: [agents.id] }),
  task: one(tasks, { fields: [logs.taskId], references: [tasks.id] }),
}));

export const approvalRelations = relations(approvals, ({ one }) => ({
  task: one(tasks, { fields: [approvals.taskId], references: [tasks.id] }),
  agent: one(agents, { fields: [approvals.agentId], references: [agents.id] }),
}));

export const messageRelations = relations(messages, ({ one }) => ({
  from: one(agents, { fields: [messages.fromAgentId], references: [agents.id], relationName: 'sentMessages' }),
  to: one(agents, { fields: [messages.toAgentId], references: [agents.id], relationName: 'receivedMessages' }),
}));

export const researchedLeadRelations = relations(researchedLeads, ({ one }) => ({
  researchedByAgent: one(agents, { fields: [researchedLeads.researchedByAgentId], references: [agents.id] }),
}));

export const jobExecutionLogRelations = relations(jobExecutionLog, ({ one }) => ({
  job: one(scheduledJobs, { fields: [jobExecutionLog.jobId], references: [scheduledJobs.id] }),
}));

export const scheduledJobRelations = relations(scheduledJobs, ({ many }) => ({
  executions: many(jobExecutionLog),
}));

// ─── Type Exports ─────────────────────────────────────────────────────────────

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type Log = typeof logs.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ResearchedLead = typeof researchedLeads.$inferSelect;
export type NewResearchedLead = typeof researchedLeads.$inferInsert;
export type HealthMetric = typeof healthMetrics.$inferSelect;
export type ComponentHealthRow = typeof componentHealth.$inferSelect;
export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type NewScheduledJob = typeof scheduledJobs.$inferInsert;
export type JobExecutionLogEntry = typeof jobExecutionLog.$inferSelect;
export type TaskOutcome = typeof taskOutcomes.$inferSelect;
export type NewTaskOutcome = typeof taskOutcomes.$inferInsert;
export type LearningInsight = typeof learningInsights.$inferSelect;
export type NewLearningInsight = typeof learningInsights.$inferInsert;
export type StrategyRecommendation = typeof strategyRecommendations.$inferSelect;
export type NewStrategyRecommendation = typeof strategyRecommendations.$inferInsert;
export type PerformanceBaseline = typeof performanceBaselines.$inferSelect;
export type NewPerformanceBaseline = typeof performanceBaselines.$inferInsert;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type NewPipelineRun = typeof pipelineRuns.$inferInsert;
export type TestResultRow = typeof testResults.$inferSelect;
export type NewTestResultRow = typeof testResults.$inferInsert;
export type LintResultRow = typeof lintResults.$inferSelect;
export type NewLintResultRow = typeof lintResults.$inferInsert;
export type DeploymentRow = typeof deployments.$inferSelect;
export type NewDeploymentRow = typeof deployments.$inferInsert;
export type ApplicationRow = typeof applications.$inferSelect;
export type NewApplicationRow = typeof applications.$inferInsert;
export type ApplicationTaskRow = typeof applicationTasks.$inferSelect;
export type NewApplicationTaskRow = typeof applicationTasks.$inferInsert;
export type PredictiveForecastRow = typeof predictiveForecasts.$inferSelect;
export type NewPredictiveForecastRow = typeof predictiveForecasts.$inferInsert;
export type RiskAssessmentRow = typeof riskAssessments.$inferSelect;
export type NewRiskAssessmentRow = typeof riskAssessments.$inferInsert;

