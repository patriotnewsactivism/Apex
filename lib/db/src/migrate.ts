import { db } from './client.js';
import * as schema from './schema.js';
import { sql } from 'drizzle-orm';

/**
 * Creates all APEX tables if they don't already exist.
 * Run this on startup instead of drizzle-kit push for zero-config local dev.
 */
export async function migrate() {
  // Use raw SQL for SQLite CREATE TABLE IF NOT EXISTS
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      system_prompt TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'gpt-4o',
      provider TEXT NOT NULL DEFAULT 'openai',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER,
      metadata TEXT
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 5,
      assigned_agent_id TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      goal_id TEXT,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 5,
      assigned_agent_id TEXT,
      created_by_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      due_at INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      result TEXT,
      error_message TEXT,
      context TEXT
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_args TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at INTEGER,
      reviewer_note TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'agent',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      task_id TEXT,
      goal_id TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      data TEXT,
      timestamp INTEGER NOT NULL
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      reply_to_id TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  // Indexes for fast lookups
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)`);
}

export { db, schema };
export * from './schema.js';
