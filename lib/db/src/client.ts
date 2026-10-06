import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { applyCrmMigration } from './crm-migration.js';

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
  await client`
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
  // Add next_retry_at column if it doesn't exist (idempotent backfill migration)
  await client`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_retry_at timestamptz
  `;
  // goals.project_id was added to schema.ts on 2026-07-18 but never to this
  // DDL, so on any fresh database every goal insert failed with
  // 'column \\\"project_id\\\" of relation \\\"goals\\\" does not exist' — submitGoal
  // (and therefore the whole autonomous loop) could not bootstrap. Additive
  // and IF NOT EXISTS: a no-op against the live database, which already has
  // the column. Not a schema change — this makes the DDL match the schema
  // that is already deployed. Found 2026-07-28 on a clean bootstrap.
  await client`
    ALTER TABLE goals ADD COLUMN IF NOT EXISTS project_id text
  `;
  // Add leased_at column for atomic task claiming (Issue 1 / CodeRabbit fix 2026-07-26).
  // dequeue() sets this on claim; crash recovery uses it to detect stale leases.
  await client`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS leased_at timestamptz
  `;
  // Cancellation attribution columns (guarded PATCH amendment 092a1729).
  // Additive and IF NOT EXISTS: no-op against a live database that already has
  // them. Populated only by the attributed cancel route; never by a done write.
  await client`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancelled_by text
  `;
  await client`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancelled_at timestamptz
  `;
  await client`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancel_reason text
  `;
  // Add the new micro-training tables
  await client`
    CREATE TABLE IF NOT EXISTS micro_training_modules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role text NOT NULL,
      title text NOT NULL,
      description text,
      content jsonb NOT NULL,
      difficulty text,
      tags jsonb,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS micro_training_recommendations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      module_id uuid NOT NULL REFERENCES micro_training_modules(id),
      role text NOT NULL,
      agent_id text,
      reason text NOT NULL,
      score real NOT NULL,
      status text NOT NULL DEFAULT 'recommended',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS micro_training_uptake (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recommendation_id uuid NOT NULL REFERENCES micro_training_recommendations(id),
      module_id uuid NOT NULL REFERENCES micro_training_modules(id),
      role text NOT NULL,
      agent_id text,
      action text NOT NULL,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Add indexes for performance
  await client`
    CREATE INDEX IF NOT EXISTS micro_training_recommendations_role_status_idx ON micro_training_recommendations (role, status)
  `;
  await client`
    CREATE INDEX IF NOT EXISTS micro_training_uptake_recommendation_id_idx ON micro_training_uptake (recommendation_id)
  `;
  // Seed data for micro-training modules (idempotent)
  await client`
    INSERT INTO micro_training_modules (id, role, title, description, content, difficulty, tags, active, created_at, updated_at)
    VALUES
      -- QA modules
      ('11111111-1111-1111-1111-111111111111', 'QA', 'Introduction to Test Automation', 'Learn the basics of test automation frameworks and best practices', '{\"overview\": \"This module covers fundamentals of test automation including tools, frameworks, and implementation strategies\"}', 'beginner', '[\"test-automation\", \"fundamentals\"]', true, now(), now()),
      ('22222222-2222-2222-2222-222222222222', 'QA', 'Advanced Debugging Techniques', 'Master advanced debugging techniques for complex software issues', '{\"overview\": \"Deep dive into debugging methodologies, tools, and strategies for resolving challenging defects\"}', 'advanced', '[\"debugging\", \"advanced\"]', true, now(), now()),
      ('33333333-3333-3333-3333-333333333333', 'QA', 'Test Case Design Principles', 'Learn effective test case design methodologies and techniques', '{\"overview\": \"Comprehensive guide to designing effective test cases including boundary testing, equivalence partitioning, and decision tables\"}', 'intermediate', '[\"test-design\", \"methodology\"]', true, now(), now()),
      -- LEAD_DEV modules
      ('44444444-4444-4444-4444-444444444444', 'LEAD_DEV', 'Technical Leadership Fundamentals', 'Core skills for effective technical leadership and team management', '{\"overview\": \"Essential technical leadership skills including communication, delegation, and team motivation\"}', 'intermediate', '[\"leadership\", \"technical\"]', true, now(), now()),
      ('55555555-5555-5555-5555-555555555555', 'LEAD_DEV', 'Code Review Best Practices', 'Master effective code review practices and techniques', '{\"overview\": \"Comprehensive guide to conducting effective code reviews that improve code quality and team knowledge sharing\"}', 'intermediate', '[\"code-review\", \"quality\"]', true, now(), now()),
      ('66666666-6666-6666-6666-666666666666', 'LEAD_DEV', 'System Design Interview Preparation', 'Prepare for system design interviews with proven frameworks and strategies', '{\"overview\": \"Structured approach to system design interviews covering scalability, performance, and architectural patterns\"}', 'advanced', '[\"system-design\", \"interview\"]', true, now(), now()),
      -- MARKETING modules
      ('77777777-7777-7777-7777-777777777777', 'MARKETING', 'Digital Marketing Fundamentals', 'Core concepts of digital marketing across channels and platforms', '{\"overview\": \"Introduction to digital marketing including SEO, SEM, social media, and email marketing\"}', 'beginner', '[\"digital-marketing\", \"fundamentals\"]', true, now(), now()),
      ('88888888-8888-8888-8888-888888888888', 'MARKETING', 'Conversion Rate Optimization', 'Learn proven techniques to improve conversion rates and maximize ROI', '{\"overview\": \"Data-driven approach to CRO including A/B testing, user experience optimization, and funnel analysis\"}', 'intermediate', '[\"cro\", \"optimization\"]', true, now(), now()),
      ('99999999-9999-9999-9999-999999999999', 'MARKETING', 'Marketing Analytics and Reporting', 'Master marketing analytics tools and reporting techniques', '{\"overview\": \"Comprehensive guide to marketing analytics including measurement, attribution, and reporting dashboards\"}', 'advanced', '[\"analytics\", \"reporting\"]', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;

  await applyCrmMigration(client);
}

export { schema };
export * from './schema.js';