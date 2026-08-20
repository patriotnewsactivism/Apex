/**
 * Context budget: keeps a single task's conversation from growing without bound.
 *
 * Why this exists (the actual "exhausts tokens" mechanism)
 * ------------------------------------------------------------------
 * `BaseAgent.executeTask` builds one `history` array and only ever pushes to it,
 * for up to `maxIterations` (default 20) turns. Every turn re-sends the whole
 * array. Tool results were appended as raw `JSON.stringify(result)` with no cap,
 * so one tool that returns a large payload — a file read, a wide DB select, an
 * HTTP body — is re-billed on every subsequent turn. Cost grows with
 * (turns x accumulated bytes), not with useful work.
 *
 * The token ledger (token-ledger.ts) caps total spend, which stops a runaway
 * from emptying the account, but it cannot tell a productive task from one that
 * is paying to re-read the same 200 KB twenty times. This module attacks the
 * cause rather than the symptom, so the caps are hit far less often.
 *
 * Two independent limits:
 *   1. Per-result — a single tool result is truncated on the way in.
 *   2. Per-request — if the whole history still exceeds the budget, the oldest
 *      tool results are elided (oldest first, since recent observations are what
 *      the model is actually reasoning about).
 *
 * Structural rule that must not be broken
 * ------------------------------------------------------------------
 * OpenAI-compatible APIs reject a request where an assistant `tool_calls`
 * message has no matching `tool` result. So nothing here ever *removes* a
 * message: elision replaces `content` and keeps `toolCallId`/`name` intact. A
 * cheaper "drop old messages" approach would produce 400s under exactly the
 * long-conversation conditions it was meant to help.
 */

/** Rough tokens-per-character. Deliberately conservative: over-estimating
 *  trims a little early, under-estimating overruns a hard provider limit. */
const CHARS_PER_TOKEN = 4;

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;
export const DEFAULT_MAX_HISTORY_TOKENS = 60_000;

export interface ContextBudgetOptions {
  /** Cap for one tool result. Env: APEX_MAX_TOOL_RESULT_CHARS */
  maxToolResultChars?: number;
  /** Cap for the whole history. Env: APEX_MAX_HISTORY_TOKENS */
  maxHistoryTokens?: number;
}

export interface BudgetMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: unknown[];
}

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
}

export function estimateHistoryTokens(history: readonly BudgetMessage[]): number {
  // +4 per message approximates the role/delimiter overhead every provider adds.
  return history.reduce((sum, m) => sum + estimateTokens(m.content ?? '') + 4, 0);
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveBudget(opts: ContextBudgetOptions = {}): Required<ContextBudgetOptions> {
  return {
    maxToolResultChars:
      opts.maxToolResultChars ??
      readPositiveInt(process.env.APEX_MAX_TOOL_RESULT_CHARS, DEFAULT_MAX_TOOL_RESULT_CHARS),
    maxHistoryTokens:
      opts.maxHistoryTokens ??
      readPositiveInt(process.env.APEX_MAX_HISTORY_TOKENS, DEFAULT_MAX_HISTORY_TOKENS),
  };
}

/**
 * Truncate one tool result, keeping the head and the tail.
 *
 * Both ends are kept on purpose: JSON payloads carry their shape at the start
 * and errors/totals at the end, and a head-only cut reliably hides the useful
 * part. The marker states how much was dropped so the model can tell the
 * difference between "small result" and "large result it cannot fully see" —
 * silent truncation invites confident answers based on a partial payload.
 */
export function truncateToolResult(content: string, maxChars: number): string {
  if (typeof content !== 'string' || content.length <= maxChars) return content;
  if (maxChars <= 0) return '';

  const marker = (omitted: number) =>
    `\n\n...[truncated by Apex context budget: ${omitted} of ${content.length} characters omitted. ` +
    `Re-run the tool with a narrower query or filter if you need the rest.]...\n\n`;

  // Reserve room for the marker itself so the result never exceeds maxChars.
  const sample = marker(content.length);
  if (sample.length >= maxChars) return content.slice(0, maxChars);

  const keep = maxChars - sample.length;
  const headLen = Math.ceil(keep * 0.6);
  const tailLen = keep - headLen;
  const head = content.slice(0, headLen);
  const tail = tailLen > 0 ? content.slice(content.length - tailLen) : '';
  return head + marker(content.length - head.length - tail.length) + tail;
}

const ELIDED = (name: string | undefined, chars: number) =>
  `[earlier result of ${name ?? 'tool'} elided by Apex context budget to stay within the model's ` +
  `context window: ${chars} characters. It is no longer visible. Call the tool again if you need it.]`;

export interface BudgetResult<T extends BudgetMessage> {
  history: T[];
  /** True when anything was changed — useful for a one-line log, not control flow. */
  modified: boolean;
  elidedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Bring a history under `maxHistoryTokens` by eliding old tool results.
 *
 * Never touches: the system prompt, the first user message (the task itself —
 * losing it makes the agent forget its objective and thrash, which costs more
 * than it saves), or the most recent `keepRecent` messages.
 *
 * Returns a new array; the input is not mutated.
 */
export function applyHistoryBudget<T extends BudgetMessage>(
  history: readonly T[],
  opts: ContextBudgetOptions & { keepRecent?: number } = {},
): BudgetResult<T> {
  const { maxHistoryTokens } = resolveBudget(opts);
  const keepRecent = opts.keepRecent ?? 4;
  const tokensBefore = estimateHistoryTokens(history);

  if (tokensBefore <= maxHistoryTokens) {
    return {
      history: [...history],
      modified: false,
      elidedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const out = [...history];
  const firstUserIdx = out.findIndex((m) => m.role === 'user');
  const protectedFrom = Math.max(0, out.length - keepRecent);
  let running = tokensBefore;
  let elidedCount = 0;

  for (let i = 0; i < out.length && running > maxHistoryTokens; i++) {
    if (i >= protectedFrom) break;
    if (i === firstUserIdx) continue;
    const m = out[i];
    if (m.role !== 'tool') continue; // assistant reasoning is small and load-bearing

    const replacement = ELIDED(m.name, m.content?.length ?? 0);
    if (replacement.length >= (m.content?.length ?? 0)) continue; // no gain

    running -= estimateTokens(m.content ?? '') - estimateTokens(replacement);
    out[i] = { ...m, content: replacement };
    elidedCount++;
  }

  return {
    history: out,
    modified: elidedCount > 0,
    elidedCount,
    tokensBefore,
    tokensAfter: estimateHistoryTokens(out),
  };
}
