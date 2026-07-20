import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required (Postgres connection string) — set it in the environment.');
}

// Supabase's transaction pooler (pgbouncer) does not support prepared statements.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, {
  schema,
  logger: process.env.DB_LOGGING === 'true',
});

// Idempotent bootstrap DDL — safe to run on every boot. Mirrors schema.ts exactly.
// Awaited fully (the original SQLite bug that caused the crash-loop was these
// statements running without await, so the server raced ahead before tables existed).
export async function migrate() {
  await client`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      role text NOT NULL,
      tier integer NOT NULL DEFAULT 0,
      parent_id text,
      status text NOT NULL DEFAULT 'idle',
      system_prompt text NOT NULL,
      model text NOT NULL DEFAULT 'gpt-4o',
      provider text NOT NULL DEFAULT 'openai',
      created_at timestamptz NOT NULL DEFAULT now(),
      last_active_at timestamptz,
      metadata jsonb
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS goals (
      id text PRIMARY KEY,
      title text NOT NULL,
      description text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      priority integer NOT NULL DEFAULT 5,
      assigned_agent_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      result text
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS tasks (
      id text PRIMARY KEY,
      goal_id text,
      parent_task_id text,
      title text NOT NULL,
      description text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      priority integer NOT NULL DEFAULT 5,
      assigned_agent_id text,
      created_by_agent_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      due_at timestamptz,
      retry_count integer NOT NULL DEFAULT 0,
      max_retries integer NOT NULL DEFAULT 3,
      result text,
      error_message text,
      context jsonb
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS approvals (
      id text PRIMARY KEY,
      task_id text NOT NULL,
      agent_id text NOT NULL,
      tool_name text NOT NULL,
      tool_args jsonb NOT NULL,
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      reviewed_at timestamptz,
      reviewer_note text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS memories (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      scope text NOT NULL DEFAULT 'agent',
      key text NOT NULL,
      value text NOT NULL,
      embedding jsonb,
      importance real NOT NULL DEFAULT 0.5,
      tags jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS logs (
      id serial PRIMARY KEY,
      agent_id text,
      task_id text,
      goal_id text,
      level text NOT NULL DEFAULT 'info',
      message text NOT NULL,
      data jsonb,
      timestamp timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS messages (
      id text PRIMARY KEY,
      from_agent_id text NOT NULL,
      to_agent_id text NOT NULL,
      subject text NOT NULL,
      body text NOT NULL,
      reply_to_id text,
      read boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS health_metrics (
      id serial PRIMARY KEY,
      component text NOT NULL,
      status text NOT NULL,
      response_time_ms integer,
      detail text,
      error_message text,
      checked_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS component_health (
      component text PRIMARY KEY,
      status text NOT NULL DEFAULT 'healthy',
      detail text,
      last_check_time timestamptz NOT NULL DEFAULT now(),
      consecutive_failures integer NOT NULL DEFAULT 0,
      metadata jsonb
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id text PRIMARY KEY,
      name text NOT NULL,
      job_type text NOT NULL,
      cron_expression text,
      scheduled_at timestamptz,
      enabled boolean NOT NULL DEFAULT true,
      target_agent_id text,
      payload jsonb,
      priority integer NOT NULL DEFAULT 5,
      status text NOT NULL DEFAULT 'active',
      retry_count integer NOT NULL DEFAULT 0,
      max_retries integer NOT NULL DEFAULT 3,
      error text,
      next_run_at timestamptz,
      last_run_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS job_execution_log (
      id serial PRIMARY KEY,
      job_id text NOT NULL,
      execution_id text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      duration_ms integer,
      status text NOT NULL DEFAULT 'running',
      output text,
      error text
    )
  `;
}

export { schema };
export * from './schema.js';
