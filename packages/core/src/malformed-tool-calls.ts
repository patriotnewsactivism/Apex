// ─── Text-encoded tool call detection ─────────────────────────────────────────
//
// Some models — especially the smaller/open ones the fallback chain drops to
// when the primary provider is exhausted (gpt-oss, qwen, glm, gemini-via-
// OpenRouter) — do not reliably use the structured tool-calling API. Instead
// they emit the call as PLAIN TEXT in the message content:
//
//   <function.runInSandbox [{"language":"python","code":"...","timeoutMs":10000}]</function
//   <tool_call>{"name": "webSearch", "arguments": {...}}</tool_call>
//   functions.readFile({"path": "src/index.ts"})
//
// To the agent loop this is indistinguishable from "I am finished": the
// provider returns `toolCalls: []`, so `executeTask` completes the task and
// stores the pseudo-call text as the RESULT. The agent did no work and
// reported success — a silent false completion. Observed live 2026-07-28: the
// DevOps agent "completed" a Tubescribe outage diagnosis in 2 seconds having
// executed nothing, and the task was recorded as done.
//
// This is the worst possible failure mode for an autonomous system, because a
// false success propagates: the delegating manager reads a "done" child task,
// reports the initiative delivered, and the goal closes on work that never
// happened. Detecting it and refusing to complete is strictly better than
// recording a lie.
//
// Deliberately NOT auto-executing what we parse out. The model failing to use
// the tool API correctly is itself evidence something is wrong with the
// provider or the prompt; guessing intent and executing it — including
// approval-gated tools like runInSandbox — is how an autonomous system takes
// an action nobody sanctioned. We detect, correct, and if it persists, fail
// honestly.

/** A text-encoded tool call found in what should have been a final answer. */
export interface MalformedToolCall {
  /** The tool the model was trying to call, when identifiable. */
  toolName?: string;
  /** Which syntax was matched — for logging, so provider quirks are traceable. */
  pattern: string;
  /** The matched excerpt, trimmed for logs. */
  excerpt: string;
}

/**
 * Detect a tool call the model wrote as prose instead of issuing through the
 * API. Returns null when the content is a genuine final answer.
 *
 * False positives matter: an agent legitimately writing "I called sendMessage
 * to delegate this" must NOT be flagged, or real completions get rejected.
 * Two defenses:
 *   1. Every pattern requires structural syntax (angle-bracket/`functions.`
 *      call form) — never a bare tool name in prose.
 *   2. When `availableToolNames` is supplied, the captured name must actually
 *      be a tool this agent can call. Prose that happens to look structural
 *      but names nothing real is ignored.
 */
export function detectMalformedToolCall(
  content: string,
  availableToolNames?: string[],
): MalformedToolCall | null {
  if (!content) return null;

  const patterns: Array<{ name: string; re: RegExp }> = [
    // <function.NAME [...]  /  <function=NAME>  /  <function name="NAME">
    { name: 'angle-function', re: /<\s*function[.=\s]+["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i },
    // <tool_call>{"name": "NAME", ...}</tool_call> and <invoke name="NAME">
    { name: 'tool_call-block', re: /<\s*tool_call\s*>[\s\S]{0,200}?["']name["']\s*:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/i },
    { name: 'invoke-block', re: /<\s*invoke\s+name\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/i },
    // Harmony-style channel routing: <|channel|>commentary to=functions.NAME
    { name: 'harmony-channel', re: /to\s*=\s*functions\.([A-Za-z_][A-Za-z0-9_]*)/i },
    // functions.NAME({...}) — the bare namespaced call form
    { name: 'functions-namespace', re: /\bfunctions\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    // <|python_tag|> — Llama-family tool preamble leaking into content
    { name: 'python-tag', re: /<\|python_tag\|>/ },
  ];

  for (const { name, re } of patterns) {
    const m = content.match(re);
    if (!m) continue;

    const captured = m[1];

    // Pattern matched but names a tool this agent doesn't have — treat as
    // prose rather than risk rejecting a legitimate final answer.
    if (captured && availableToolNames && availableToolNames.length > 0) {
      if (!availableToolNames.includes(captured)) continue;
    }

    const idx = m.index ?? 0;
    return {
      toolName: captured,
      pattern: name,
      excerpt: content.slice(Math.max(0, idx - 20), idx + 180).trim(),
    };
  }

  return null;
}

/** The corrective message pushed back at a model that text-encoded a call.
 *  Concrete and short — a long lecture tends to make small models produce
 *  more prose, which is the problem we are trying to stop. */
export function buildMalformedToolCallCorrection(found: MalformedToolCall): string {
  const which = found.toolName ? `\`${found.toolName}\`` : 'a tool';
  return [
    `STOP. You wrote a tool call as TEXT instead of issuing it: ${which} (matched: ${found.pattern}).`,
    'Text like that does not execute. Nothing ran. The work is NOT done.',
    '',
    'Issue the call through the tool-calling API — the structured mechanism you were given, not message content.',
    'Do not describe the call, do not wrap it in tags, do not print it in a code block.',
    '',
    'If you cannot issue tool calls, say so plainly in one sentence and report what you were unable to do.',
    'Do NOT report success for work that did not run.',
  ].join('\n');
}
