// ─── "I couldn't do it" is not a completed task ───────────────────────────────
//
// Second door into the same false-success failure mode that text-encoded tool
// calls came through (see malformed-tool-calls.ts). There, the agent emitted a
// call as prose and the loop read `toolCalls: []` as "finished". Here the agent
// simply *says* it failed — and the loop still records `status: 'done'`,
// because any no-tool-call turn is treated as a successful final answer.
//
// Observed live 2026-07-29, minutes after the first real deploy:
//
//   [frontend]    "I am unable to access the code for the frontend."   → completed
//   [devops]      "I'm sorry, I don't have access to the deployment…"  → completed
//   [backend]     "ERR_MODULE_NOT_FOUND …"                             → completed
//   [qa-director] "Severity: N/A  Finding: N/A  Suggested Fix: N/A"    → completed
//   [lead-dev]    "I have not yet received the results…"               → completed
//
// Every one of those is a failure recorded as a success, and each propagates:
// the delegating manager reads a `done` child, and the goal closes on work that
// never happened.
//
// Worth being precise about the frontend/devops cases, because they are not
// capability gaps. `apex-frontend-001` has readFile/listDir/fetchUrl and
// `apex-devops-001` has readFile/listDir/runShell/runInSandbox — both had the
// tools they claimed to lack and simply did not try. Marking that "done" is
// what makes it rational: giving up is cheaper than working, and nothing
// downstream can tell the difference.
//
// This detector runs only AFTER the self-review turn, so the agent has already
// been given one explicit chance to notice the gap and keep working. If it
// still reports inability, the task fails honestly and re-enters the retry path
// (which may land on a healthier provider), then goes to FailureReviewJob for
// triage. Failing loudly beats a queue full of fictitious successes.

/** A final answer that admits the work was not done. */
export interface NonCompletion {
  /** Which signature matched — logged so patterns can be tuned against reality. */
  pattern: string;
  /** The matched fragment, for the failure message. */
  excerpt: string;
}

/** First-person admissions of not having done the work. Deliberately anchored
 *  to "I <cannot/did not>" forms rather than bare keywords: a report that
 *  mentions the word "unable" while still delivering findings must not match. */
const GAVE_UP_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'no-access', re: /\bI\s+(?:do\s*n[o']t|don't|cannot|can't)\s+have\s+access\b/i },
  { name: 'unable-to', re: /\bI\s*(?:'m|\s+am)\s+(?:unable|not\s+able)\s+to\b/i },
  { name: 'cannot-verb', re: /\bI\s+(?:cannot|can't|could\s*n[o']t|couldn't)\s+(?:access|complete|perform|retrieve|find|run|execute|determine)\b/i },
  { name: 'apology-error', re: /\bI'?m\s+sorry[, ].{0,60}\b(?:error|unable|cannot|can't|do\s*n[o']t\s+have)\b/i },
  { name: 'awaiting-results', re: /\bI\s+have\s+not\s+(?:yet\s+)?received\b/i },
  { name: 'no-results', re: /\bI\s+(?:could\s*n[o']t|couldn't|was\s+unable\s+to)\s+find\s+any\b/i },
  { name: 'raw-error-dump', re: /\bERR_[A-Z_]+\b|\bError\s*\[[A-Z_]+\]/ },
];

/** A report whose every field is N/A — structurally "I produced nothing" even
 *  though no apology appears. Needs 3+ to avoid catching one legitimately
 *  not-applicable field in an otherwise real report. */
const ALL_NA = /(?:\b(?:Severity|Finding|Suggested\s+Fix|Result|Status)\s*[::]\s*N\/?A\b[\s\S]{0,120}){3,}/i;

/**
 * Decide whether a final answer is really a failure dressed as a completion.
 *
 * `contentLength` guards the main false positive: a substantial report that
 * happens to note a limitation ("I was unable to reach the staging host, so the
 * numbers below are from prod") is genuine work and must complete normally.
 * Only terse answers that are *nothing but* an admission are failures.
 *
 * Note this does NOT catch a deliberate no-action result — "system is healthy,
 * nothing needs doing" is a legitimate short completion that the autonomous
 * review prompts explicitly ask for, and it matches none of these patterns.
 */
export function detectNonCompletion(
  content: string,
  opts: { maxChars?: number } = {},
): NonCompletion | null {
  if (!content) return null;
  const maxChars = opts.maxChars ?? 800;

  // Long answers carry real content; a limitation mentioned inside one is a
  // caveat, not a failure.
  if (content.length > maxChars) return null;

  for (const { name, re } of GAVE_UP_PATTERNS) {
    const m = content.match(re);
    if (m) {
      const idx = m.index ?? 0;
      return { pattern: name, excerpt: content.slice(Math.max(0, idx - 20), idx + 200).trim() };
    }
  }

  const na = content.match(ALL_NA);
  if (na) {
    return { pattern: 'all-fields-na', excerpt: content.slice(0, 200).trim() };
  }

  return null;
}

/** The failure message recorded on the task. Written so FailureReviewJob's
 *  clustering groups these together, and so a human reading the Task Board can
 *  see at a glance that the agent gave up rather than hit an infrastructure
 *  fault. */
export function buildNonCompletionFailure(found: NonCompletion, hadToolCalls: boolean): string {
  return [
    `Agent reported it did not complete the work (${found.pattern}), so this task is NOT done.`,
    hadToolCalls
      ? 'It did use tools, but its final answer still reports the objective was not met.'
      : 'It executed NO tools at all before giving up — the work was never attempted.',
    'Recorded as failed rather than done: a task marked complete on an admission of failure',
    'propagates upward as a fictitious success.',
    `Agent said: "${found.excerpt.slice(0, 220)}"`,
  ].join(' ');
}


/**
 * Catch a final answer that ANNOUNCES an action instead of taking it.
 *
 * Observed live 2026-07-29, and it is precisely why leads stopped saving:
 *
 *   [lead-research] "I have found 20 legal firms in Miami, FL. I will now save
 *                    these leads using saveResearchedLeadsBatch."
 *   [lead-research] Task completed        <- saveResearchedLeadsBatch never called
 *
 * The research genuinely succeeded — 20 real firms — and then the agent
 * narrated the save rather than performing it. The task completed, the manager
 * saw a success, and nothing reached the database. An announcement in a turn
 * with NO tool calls means the action did not happen, full stop.
 *
 * Tightly scoped to avoid eating legitimate hand-offs: the sentence must be
 * first-person future tense AND name a tool this agent actually has. "I will
 * report back once the CTO responds" names no tool and passes; "I will now
 * save these using saveResearchedLeadsBatch" names one and fails.
 */
export function detectAnnouncedButNotTaken(
  content: string,
  availableToolNames: string[],
): NonCompletion | null {
  if (!content || availableToolNames.length === 0) return null;

  // First-person intent to act, followed shortly by a real tool name.
  const intent = /\b(?:I(?:'ll| will| am going to| shall)|[Ll]et me|[Nn]ext,? I(?:'ll| will))\b/g;
  let m: RegExpExecArray | null;
  while ((m = intent.exec(content)) !== null) {
    // Only look at the clause the intent introduces, not the whole document —
    // a tool named three paragraphs later is unrelated.
    const clause = content.slice(m.index, m.index + 220);
    const named = availableToolNames.find((t) => clause.includes(t));
    if (named) {
      return {
        pattern: `announced-not-taken:${named}`,
        excerpt: clause.trim().slice(0, 200),
      };
    }
  }
  return null;
}
