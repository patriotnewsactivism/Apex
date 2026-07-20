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
  await client`
    CREATE TABLE IF NOT EXISTS task_outcomes (
      id serial PRIMARY KEY,
      task_id text NOT NULL,
      agent_id text NOT NULL,
      role text NOT NULL,
      duration_ms integer NOT NULL,
      success boolean NOT NULL,
      quality_score real NOT NULL DEFAULT 1.0,
      tool_executions integer NOT NULL DEFAULT 0,
      llm_calls integer NOT NULL DEFAULT 0,
      iterations integer NOT NULL DEFAULT 1,
      required_approvals integer NOT NULL DEFAULT 0,
      error_type text,
      complexity real NOT NULL DEFAULT 0.5,
      satisfaction_metric real NOT NULL DEFAULT 1.0,
      tags jsonb,
      recorded_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS learning_insights (
      id text PRIMARY KEY,
      insight_type text NOT NULL,
      title text NOT NULL,
      description text NOT NULL,
      confidence real NOT NULL DEFAULT 0.8,
      evidence jsonb,
      applied boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS strategy_recommendations (
      id text PRIMARY KEY,
      recommendation_type text NOT NULL,
      title text NOT NULL,
      text text NOT NULL,
      expected_impact text NOT NULL,
      confidence real NOT NULL DEFAULT 0.8,
      status text NOT NULL DEFAULT 'pending',
      reviewed_at timestamptz,
      reviewer_note text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS performance_baselines (
      metric_name text PRIMARY KEY,
      baseline_value real NOT NULL,
      measurement_window text NOT NULL DEFAULT '30d',
      sample_size integer NOT NULL DEFAULT 0,
      valid_until timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id text PRIMARY KEY,
      repo text NOT NULL DEFAULT 'Apex',
      branch text NOT NULL DEFAULT 'main',
      commit_sha text,
      status text NOT NULL DEFAULT 'running',
      trigger_type text NOT NULL DEFAULT 'manual',
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      duration_ms integer,
      error text
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS test_results (
      id serial PRIMARY KEY,
      run_id text NOT NULL,
      total_tests integer NOT NULL DEFAULT 0,
      passed integer NOT NULL DEFAULT 0,
      failed integer NOT NULL DEFAULT 0,
      skipped integer NOT NULL DEFAULT 0,
      duration_ms integer NOT NULL DEFAULT 0,
      coverage_pct real,
      test_report jsonb,
      recorded_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS lint_results (
      id serial PRIMARY KEY,
      run_id text NOT NULL,
      total_files integer NOT NULL DEFAULT 0,
      errors integer NOT NULL DEFAULT 0,
      warnings integer NOT NULL DEFAULT 0,
      lint_report jsonb,
      recorded_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS deployments (
      id text PRIMARY KEY,
      run_id text,
      environment text NOT NULL DEFAULT 'production',
      platform text NOT NULL DEFAULT 'railway',
      deployment_url text,
      status text NOT NULL DEFAULT 'pending',
      rolled_back boolean NOT NULL DEFAULT false,
      error text,
      deployed_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS applications (
      id text PRIMARY KEY,
      name text NOT NULL,
      repo_url text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      health_score real NOT NULL DEFAULT 1.0,
      last_sync_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS application_tasks (
      id serial PRIMARY KEY,
      app_id text NOT NULL,
      task_name text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS predictive_forecasts (
      id text PRIMARY KEY,
      metric_name text NOT NULL,
      forecast_value real NOT NULL,
      confidence real NOT NULL DEFAULT 0.8,
      window text NOT NULL DEFAULT '7d',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS risk_assessments (
      id text PRIMARY KEY,
      target text NOT NULL,
      risk_level text NOT NULL,
      details text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export { schema };
export * from './schema.js';
