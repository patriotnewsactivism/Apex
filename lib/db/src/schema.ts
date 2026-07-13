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

// ─── Goals ───────────────────────────────────────────────────────────────────

export const goals = pgTable('goals', {
  id: text('id').primaryKey(),
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

export const goalRelations = relations(goals, ({ many, one }) => ({
  tasks: many(tasks),
  assignedAgent: one(agents, { fields: [goals.assignedAgentId], references: [agents.id] }),
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
