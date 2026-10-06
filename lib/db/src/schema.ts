import { pgTable, text, uuid, timestamp, jsonb, boolean, real } from 'drizzle-orm/pg-core';

export const microTrainingModules = pgTable('micro_training_modules', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: text('role').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  content: jsonb('content').notNull(),
  difficulty: text('difficulty'),
  tags: jsonb('tags').$type<string[]>(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const microTrainingRecommendations = pgTable('micro_training_recommendations', {
  id: uuid('id').primaryKey().defaultRandom(),
  moduleId: uuid('module_id')
    .references(() => microTrainingModules.id)
    .notNull(),
  role: text('role').notNull(),
  agentId: text('agent_id'),
  reason: text('reason').notNull(),
  score: real('score').notNull(),
  status: text('status').notNull().default('recommended'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const microTrainingUptake = pgTable('micro_training_uptake', {
  id: uuid('id').primaryKey().defaultRandom(),
  recommendationId: uuid('recommendation_id')
    .references(() => microTrainingRecommendations.id)
    .notNull(),
  moduleId: uuid('module_id')
    .references(() => microTrainingModules.id)
    .notNull(),
  role: text('role').notNull(),
  agentId: text('agent_id'),
  action: text('action').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});