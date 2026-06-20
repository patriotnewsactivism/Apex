import { randomUUID } from 'crypto';
import { db, memories, logs } from '@workspace/db';
import { eq, and, desc, like, or } from 'drizzle-orm';
import type { Memory } from '@workspace/db';

// ─── Memory Manager ───────────────────────────────────────────────────────────

export class MemoryManager {
  private agentId: string;
  private contextWindow: Array<{ role: string; content: string }> = [];
  private readonly maxContextMessages = 20;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  // ── Short-term (in-context) memory ─────────────────────────────────────────

  addToContext(role: string, content: string) {
    this.contextWindow.push({ role, content });
    // Trim to keep only recent messages
    if (this.contextWindow.length > this.maxContextMessages) {
      // Keep system messages + last N messages
      const systemMessages = this.contextWindow.filter((m) => m.role === 'system');
      const recentMessages = this.contextWindow.filter((m) => m.role !== 'system').slice(-this.maxContextMessages);
      this.contextWindow = [...systemMessages, ...recentMessages];
    }
  }

  clearContext() {
    this.contextWindow = [];
  }

  getContext() {
    return [...this.contextWindow];
  }

  // ── Long-term (persistent) memory ──────────────────────────────────────────

  async remember(
    key: string,
    value: string,
    options?: { scope?: Memory['scope']; importance?: number; tags?: string[]; ttlMs?: number },
  ): Promise<void> {
    const now = new Date();
    const expiresAt = options?.ttlMs ? new Date(Date.now() + options.ttlMs) : undefined;

    // Upsert: update if key already exists for this agent
    const existing = await db
      .select()
      .from(memories)
      .where(and(eq(memories.agentId, this.agentId), eq(memories.key, key)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(memories)
        .set({
          value,
          importance: options?.importance ?? existing[0].importance,
          tags: options?.tags ?? existing[0].tags,
          updatedAt: now,
          expiresAt: expiresAt ?? existing[0].expiresAt,
        })
        .where(eq(memories.id, existing[0].id));
    } else {
      await db.insert(memories).values({
        id: randomUUID(),
        agentId: this.agentId,
        scope: options?.scope ?? 'agent',
        key,
        value,
        importance: options?.importance ?? 0.5,
        tags: options?.tags ?? [],
        createdAt: now,
        updatedAt: now,
        expiresAt,
      });
    }
  }

  async recall(query: string, limit = 10): Promise<Memory[]> {
    const now = new Date();
    // Simple keyword recall (no vector embeddings required)
    const results = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.agentId, this.agentId),
          or(like(memories.key, `%${query}%`), like(memories.value, `%${query}%`)),
        ),
      )
      .orderBy(desc(memories.importance))
      .limit(limit);

    // Filter out expired memories
    return results.filter((m) => !m.expiresAt || m.expiresAt > now);
  }

  async getAll(scope?: Memory['scope']): Promise<Memory[]> {
    const now = new Date();
    const rows = await db
      .select()
      .from(memories)
      .where(
        scope
          ? and(eq(memories.agentId, this.agentId), eq(memories.scope, scope))
          : eq(memories.agentId, this.agentId),
      )
      .orderBy(desc(memories.importance));

    return rows.filter((m) => !m.expiresAt || m.expiresAt > now);
  }

  async forget(key: string): Promise<void> {
    await db
      .delete(memories)
      .where(and(eq(memories.agentId, this.agentId), eq(memories.key, key)));
  }

  /** Format top memories as a concise context block for injection into prompts */
  async buildMemoryContext(query?: string): Promise<string> {
    const mems = query ? await this.recall(query, 8) : await this.getAll();
    if (mems.length === 0) return '';

    const lines = mems
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10)
      .map((m) => `- [${m.key}]: ${m.value}`);

    return `\n## My Memories\n${lines.join('\n')}\n`;
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'thinking' | 'acting';

export class AgentLogger {
  private agentId: string;
  private onLog?: (level: LogLevel, message: string, data?: unknown) => void;

  constructor(agentId: string, onLog?: (level: LogLevel, message: string, data?: unknown) => void) {
    this.agentId = agentId;
    this.onLog = onLog;
  }

  async log(level: LogLevel, message: string, data?: Record<string, unknown>, taskId?: string, goalId?: string) {
    const now = new Date();

    // Console output with emoji
    const prefix: Record<LogLevel, string> = {
      debug: '🔍',
      info: '📋',
      warn: '⚠️',
      error: '❌',
      thinking: '🧠',
      acting: '⚡',
    };
    console.log(`${prefix[level]} [${this.agentId}] ${message}`);

    // Persist to DB
    await db.insert(logs).values({
      agentId: this.agentId,
      taskId,
      goalId,
      level,
      message,
      data,
      timestamp: now,
    });

    // Fire callback for WebSocket broadcast
    this.onLog?.(level, message, data);
  }

  thinking(msg: string, taskId?: string) { return this.log('thinking', msg, undefined, taskId); }
  acting(msg: string, taskId?: string) { return this.log('acting', msg, undefined, taskId); }
  info(msg: string, taskId?: string) { return this.log('info', msg, undefined, taskId); }
  warn(msg: string, taskId?: string) { return this.log('warn', msg, undefined, taskId); }
  error(msg: string, err?: unknown, taskId?: string) {
    return this.log('error', msg, err instanceof Error ? { message: err.message, stack: err.stack } : { err }, taskId);
  }
}
