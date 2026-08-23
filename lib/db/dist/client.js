import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/apex';
// Supabase's transaction pooler (pgbouncer) does not support prepared statements.
const client = postgres(connectionString, {
    prepare: false,
    max: 20,
    idle_timeout: 30,
    // Prune connections before Supabase's pgbouncer silently drops them —
    // postgres.js defaults max_lifetime to unlimited, leaving stuck slots
    // that hang the whole pool (and therefore the whole server) until restart.
    max_lifetime: 60 * 30,
    connect_timeout: 15,
});
export const db = drizzle(client, {
    schema,
    logger: process.env.DB_LOGGING === 'true',
});
// Idempotent bootstrap DDL — safe to run on every boot. Mirrors schema.ts exactly.
// Awaited fully (the original SQLite bug that caused the crash-loop was these
// statements running without await, so the server raced ahead before tables existed).
export async function migrate() {
    await client `
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY,
      name text NOT NULL,
      repository text,
      purpose text NOT NULL,
      priority text NOT NULL DEFAULT 'normal',
      status text NOT NULL DEFAULT 'active',
      autonomy_level text NOT NULL DEFAULT 'supervisor',
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    await client `
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
    await client `
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
    await client `
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
    // Add next_retry_at column if it doesn't exist (idempotent backfill migration)
    await client `
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_retry_at timestamptz
  `;
    // goals.project_id was added to schema.ts on 2026-07-18 but never to this
    // DDL, so on any fresh database every goal insert failed with
    // 'column "project_id" of relation "goals" does not exist' — submitGoal
    // (and therefore the whole autonomous loop) could not bootstrap. Additive
    // and IF NOT EXISTS: a no-op against the live database, which already has
    // the column. Not a schema change — this makes the DDL match the schema
    // that is already deployed. Found 2026-07-28 on a clean bootstrap.
    await client `
    ALTER TABLE goals ADD COLUMN IF NOT EXISTS project_id text
  `;
    // Add leased_at column for atomic task claiming (Issue 1 / CodeRabbit fix 2026-07-26).
    // dequeue() sets this on claim; crash recovery uses it to detect stale leases.
    await client `
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS leased_at timestamptz
  `;
    // Unique partial index for delegation idempotency (Issue 3 / CodeRabbit fix 2026-07-26).
    // Prevents two concurrent workers from both inserting the same (goal, title, agent) task.
    // Partial (WHERE goal_id IS NOT NULL) because goal_id is nullable for ad-hoc tasks.
    // Wrapped in try/catch: dedup existing rows first, then create index. If index creation
    // fails (e.g. still-duplicate rows from a concurrent writer), log a warning and continue
    // so remaining bootstrap steps are not aborted.
    try {
        await client `
      DELETE FROM tasks t
      USING (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY goal_id, title, assigned_agent_id ORDER BY created_at ASC) as rn
        FROM tasks
        WHERE goal_id IS NOT NULL AND assigned_agent_id IS NOT NULL
      ) dupes
      WHERE t.id = dupes.id AND dupes.rn > 1
    `;
        await client `
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_delegation_unique
      ON tasks(goal_id, title, assigned_agent_id)
      WHERE goal_id IS NOT NULL
    `;
    }
    catch (err) {
        console.warn('⚠️  tasks_delegation_unique index not created:', err instanceof Error ? err.message : String(err));
    }
    await client `
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
    // ── approvals: separate escalations from real approval gates (2026-08-22) ──
    // The table mixed genuine per-tool approval gates with escalate_to_human
    // rows, which are not gated at all. 8,683 escalations buried 16 real
    // approvals under one status='pending' filter. Additive + IF NOT EXISTS, so
    // this is a no-op on a database that already has the columns.
    await client `
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'approval'
  `;
    await client `
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS dedupe_key text
  `;
    await client `
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS occurrences integer NOT NULL DEFAULT 1
  `;
    await client `
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS last_occurred_at timestamptz
  `;
    // Label pre-existing escalations. Runs once in practice: after the first
    // pass no escalate_to_human row still carries kind='approval'.
    await client `
    UPDATE approvals SET kind = 'escalation'
    WHERE tool_name = 'escalate_to_human' AND kind <> 'escalation'
  `;
    // One-time amnesty for the backlog accumulated before dedupe existed. These
    // rows were never triaged and never will be — leaving them 'pending' means
    // the escalation tab opens onto thousands of stale rows and stays useless.
    // Scoped to rows older than 24h at the moment of the sweep, so a genuinely
    // fresh escalation is never swept away by a deploy.
    await client `
    UPDATE approvals
    SET status = 'stale',
        reviewer_note = COALESCE(reviewer_note, 'Auto-closed 2026-08-22: pre-dedupe escalation backlog, never triaged.')
    WHERE kind = 'escalation'
      AND status = 'pending'
      AND created_at < now() - interval '24 hours'
  `;
    // Dedupe lookups hit (kind, status, dedupe_key) on every escalation.
    await client `
    CREATE INDEX IF NOT EXISTS approvals_escalation_dedupe_idx
    ON approvals (kind, status, dedupe_key)
  `;
    await client `
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
    await client `
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
    await client `
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
    // Add idempotency_key for sendMessage dedup on retry (Issue 4 / CodeRabbit fix 2026-07-26).
    // Partial unique index (WHERE IS NOT NULL) so legacy NULL rows don't conflict each other.
    await client `
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key text
  `;
    await client `
    CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_key_unique
    ON messages(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `;
    await client `
    CREATE TABLE IF NOT EXISTS researched_leads (
      id text PRIMARY KEY,
      company_name text NOT NULL,
      website text,
      industry text,
      city text,
      fit_reason text NOT NULL,
      outreach_angle text,
      status text NOT NULL DEFAULT 'new',
      researched_by_agent_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    // ── Lead campaigns (2026-08-22) ──────────────────────────────────────────
    // A bounded, observable lead hunt. campaign_id on researched_leads is
    // nullable so the 4,722 pre-campaign rows are untouched.
    await client `
    ALTER TABLE researched_leads ADD COLUMN IF NOT EXISTS campaign_id text
  `;
    await client `
    ALTER TABLE researched_leads ADD COLUMN IF NOT EXISTS campaign_segment_id text
  `;
    await client `
    CREATE INDEX IF NOT EXISTS researched_leads_campaign_idx
    ON researched_leads (campaign_id, status)
  `;
    // De-dup on website is the hot path of every segment run (thousands of rows
    // checked per campaign). Partial: NULL websites are not comparable anyway.
    await client `
    CREATE INDEX IF NOT EXISTS researched_leads_website_idx
    ON researched_leads (website) WHERE website IS NOT NULL
  `;
    await client `
    CREATE TABLE IF NOT EXISTS lead_campaigns (
      id text PRIMARY KEY,
      name text NOT NULL,
      goal_id text,
      project_id text,
      icp jsonb NOT NULL,
      target_leads integer NOT NULL DEFAULT 100,
      status text NOT NULL DEFAULT 'running',
      push_to_buildmybot boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      last_progress_at timestamptz,
      created_by_agent_id text,
      result text
    )
  `;
    await client `
    CREATE TABLE IF NOT EXISTS campaign_segments (
      id text PRIMARY KEY,
      campaign_id text NOT NULL,
      industry text NOT NULL,
      city text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      found integer NOT NULL DEFAULT 0,
      saved integer NOT NULL DEFAULT 0,
      duplicates integer NOT NULL DEFAULT 0,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      leased_at timestamptz,
      last_error text,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    // A campaign must never enqueue the same territory twice.
    await client `
    CREATE UNIQUE INDEX IF NOT EXISTS campaign_segments_cell_unique
    ON campaign_segments (campaign_id, industry, city)
  `;
    // The claim query: next pending segment for a running campaign.
    await client `
    CREATE INDEX IF NOT EXISTS campaign_segments_claim_idx
    ON campaign_segments (campaign_id, status, created_at)
  `;
    await client `
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
    await client `
    CREATE TABLE IF NOT EXISTS llm_token_usage_daily (
      day text NOT NULL,
      provider text NOT NULL,
      prompt_tokens integer NOT NULL DEFAULT 0,
      completion_tokens integer NOT NULL DEFAULT 0,
      calls integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (day, provider)
    )
  `;
    await client `
    CREATE TABLE IF NOT EXISTS component_health (
      component text PRIMARY KEY,
      status text NOT NULL DEFAULT 'healthy',
      detail text,
      last_check_time timestamptz NOT NULL DEFAULT now(),
      consecutive_failures integer NOT NULL DEFAULT 0,
      metadata jsonb
    )
  `;
    await client `
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
    await client `
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
    await client `
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
    await client `
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
    await client `
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
    await client `
    CREATE TABLE IF NOT EXISTS performance_baselines (
      metric_name text PRIMARY KEY,
      baseline_value real NOT NULL,
      measurement_window text NOT NULL DEFAULT '30d',
      sample_size integer NOT NULL DEFAULT 0,
      valid_until timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    await client `
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
    await client `
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
    await client `
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
    await client `
    CREATE TABLE IF NOT EXISTS deployments (
      id text PRIMARY KEY,
      run_id text,
      environment text NOT NULL DEFAULT 'production',
      platform text NOT NULL DEFAULT 'local',
      deployment_url text,
      status text NOT NULL DEFAULT 'pending',
      rolled_back boolean NOT NULL DEFAULT false,
      error text,
      deployed_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    await client `
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
    await client `
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
    await client `
    CREATE TABLE IF NOT EXISTS predictive_forecasts (
      id text PRIMARY KEY,
      metric_name text NOT NULL,
      forecast_value real NOT NULL,
      confidence real NOT NULL DEFAULT 0.8,
      -- "window" is a reserved keyword in Postgres and MUST stay quoted here.
      -- Unquoted, this statement raised a syntax error that aborted migrate()
      -- part-way through: predictive_forecasts, risk_assessments and
      -- integration_settings were never created on a fresh database, and the
      -- failure surfaced only as a warning ("migration skipped or deferred").
      -- Drizzle quotes identifiers itself, so ORM reads/writes were unaffected
      -- and hid the gap. Found 2026-07-28 while bootstrapping a clean DB.
      "window" text NOT NULL DEFAULT '7d',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    await client `
    CREATE TABLE IF NOT EXISTS risk_assessments (
      id text PRIMARY KEY,
      target text NOT NULL,
      risk_level text NOT NULL,
      details text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    await client `
    CREATE TABLE IF NOT EXISTS integration_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    )
  `;
}
export { schema };
export * from './schema.js';
