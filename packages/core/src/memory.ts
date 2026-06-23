import { randomUUID } from 'crypto';
import { db, memories, logs } from '@workspace/db';
import { eq, and, desc, like, or } from 'drizzle-orm';
import type { Memory } from '@workspace/db';

// ─── Cosine Similarity helper ──────────────────────────────────────────────────

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(vecA.length, vecB.length);
  for (let i = 0; i < len; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

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

    let embedding: number[] | null = null;
    try {
      const { createEmbedding } = await import('./llm-client.js');
      embedding = await createEmbedding(`${key}: ${value}`);
    } catch (err) {
      console.warn('Failed to generate embedding for memory:', err);
    }

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
          embedding: embedding || existing[0].embedding,
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
        embedding,
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
    
    try {
      const { createEmbedding } = await import('./llm-client.js');
      const queryEmbedding = await createEmbedding(query);
      
      const rows = await db
        .select()
        .from(memories)
        .where(
          or(
            eq(memories.agentId, this.agentId),
            eq(memories.scope, 'global'),
            eq(memories.scope, 'project')
          )
        );

      const activeRows = rows.filter((m) => !m.expiresAt || m.expiresAt > now);

      // Rank by cosine similarity + importance weight
      const scored = activeRows.map((m) => {
        let similarity = 0;
        if (m.embedding && Array.isArray(m.embedding)) {
          similarity = cosineSimilarity(queryEmbedding, m.embedding);
        }
        // Score is similarity * 0.8 + (importance * 0.2)
        const finalScore = similarity * 0.8 + (m.importance * 0.2);
        return { memory: m, score: finalScore };
      });

      // Sort descending and limit
      const results = scored
        .filter((s) => s.score > 0.1) // threshold
        .sort((a, b) => b.score - a.score)
        .map((s) => s.memory);

      return results.slice(0, limit);
    } catch (err) {
      console.warn('Vector recall failed, falling back to keyword search:', err);
      // Fallback: Simple keyword recall
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
