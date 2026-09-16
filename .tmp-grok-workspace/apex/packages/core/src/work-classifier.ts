/**
 * Heavy-work classifier (Phase 4 of the autonomous-OS upgrade).
 *
 * WHY ADVISORY, NOT AUTOMATIC REASSIGNMENT
 * ------------------------------------------------------------------
 * The sandbox executor already exists and works: an agent calls
 * run_executor_job, which creates a NEW task with context.runtime='job'. Once
 * that flag is set, TaskQueue.dequeue() stops offering the row to any
 * in-process agent, and the 30s dispatch loop (dispatch.ts) hands it to a
 * Cloud Run Job running a completely different, fixed identity
 * (apex-executor-001, executorTools(), its own system prompt) — not whoever
 * the task was originally assigned to. That reassignment is correct and
 * deliberate for genuinely NEW executor-bound work, but it means silently
 * flipping runtime='job' on an EXISTING delegated task would silently swap
 * out the receiving agent's role-specific tools and persona underneath it —
 * a correctness risk this classifier must not introduce.
 *
 * So this module only classifies and advises. It runs at two safe points:
 * delegation time (BaseAgent.delegate/delegateToRole annotate the task with
 * the classifier's finding) and execution time (BaseAgent.executeTask nudges
 * an agent that is ABOUT to do heavy work in-process toward calling the
 * run_executor_job tool it already has). The actual routing decision, and
 * the actual reassignment, stay exactly where they already were: an explicit
 * tool call.
 */

export type WorkloadCategory =
  | 'test_suite'
  | 'build'
  | 'render'
  | 'static_analysis'
  | 'browser_automation'
  | 'data_processing'
  | 'code_generation_verification'
  | 'integration_test'
  | 'none';

export interface WorkloadClassification {
  heavy: boolean;
  /** 0..1 — how confident the signal match is. Purely a count/strength
   *  heuristic over matched phrases, never an LLM judgment call. */
  confidence: number;
  category: WorkloadCategory;
  /** The literal phrases that matched, for logging/audit — never inferred. */
  signals: string[];
}

interface SignalRule {
  category: WorkloadCategory;
  patterns: RegExp[];
}

// Ordered by specificity; the first matching category wins so a phrase that
// could match two buckets (e.g. "run the full test suite and build") is
// classified by whichever rule appears first rather than double-counted.
const RULES: SignalRule[] = [
  {
    category: 'test_suite',
    patterns: [
      /\bfull\s+(repo(sitory)?[- ]wide|repository)?\s*test\s*suite\b/i,
      /\brun\s+(all|every)\s+tests?\b/i,
      /\bentire\s+test\s+suite\b/i,
      /\bpnpm\s+(run\s+)?test(:\S+)?\b.*\ball\b/i,
    ],
  },
  {
    category: 'integration_test',
    patterns: [/\bintegration\s+tests?\b/i, /\bend-?to-?end\s+tests?\b/i, /\be2e\s+tests?\b/i, /\blengthy\s+integration\b/i],
  },
  {
    category: 'build',
    patterns: [/\bbuild\s+the\s+(project|dashboard|app|repo(sitory)?)\b/i, /\bfull\s+build\b/i, /\bproduction\s+build\b/i, /\bcompile\s+the\s+entire\b/i],
  },
  {
    category: 'render',
    patterns: [/\brender(ing)?\s+(a\s+)?(video|animation|image\s+sequence|scene)\b/i, /\bvideo\s+render\b/i, /\btranscod(e|ing)\b/i],
  },
  {
    category: 'static_analysis',
    patterns: [/\brepo(sitory)?[- ]wide\s+static\s+analysis\b/i, /\bfull\s+lint\b/i, /\bcodebase[- ]wide\s+(scan|analysis|audit)\b/i, /\bsecurity\s+scan\s+of\s+the\s+(entire|whole|full)\b/i],
  },
  {
    category: 'browser_automation',
    patterns: [/\blong[- ]running\s+browser\s+automation\b/i, /\bcrawl\s+(the\s+)?(entire|whole|full)\s+site\b/i, /\bmulti[- ]page\s+browser\s+(test|automation)\b/i],
  },
  {
    category: 'data_processing',
    patterns: [/\blarge[- ]scale\s+data\s+processing\b/i, /\bprocess(ing)?\s+(a\s+)?(large|bulk|entire)\s+dataset\b/i, /\bbatch\s+process\s+\d{3,}\b/i],
  },
  {
    category: 'code_generation_verification',
    patterns: [/\bverify\s+(large|generated)\s+code\s+(generation|output)\b/i, /\bgenerate\s+and\s+verify\s+(a\s+)?(large|full)\b/i],
  },
];

/** How many distinct rule matches (across categories) make a task worth
 *  advising on even without one very strong single signal. */
const MULTI_SIGNAL_THRESHOLD = 2;

/**
 * Classify a task's likely resource cost from its own stated title and
 * description. Deterministic and cheap (regex over text APEX itself wrote or
 * a human wrote) — no LLM call, so it can run on every delegation without
 * adding latency or cost, and its output is reproducible for tests.
 */
export function classifyWorkload(title: string, description: string): WorkloadClassification {
  const text = `${title}\n${description}`;
  const signals: string[] = [];
  let bestCategory: WorkloadCategory = 'none';
  let matchCount = 0;

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match) {
        signals.push(match[0]);
        matchCount++;
        if (bestCategory === 'none') bestCategory = rule.category;
      }
    }
  }

  if (matchCount === 0) {
    return { heavy: false, confidence: 0, category: 'none', signals: [] };
  }

  // One strong, specific phrase match is already good evidence; more matches
  // (even across categories — "run all tests, then a full build") raise
  // confidence further, capped at 1.
  const confidence = Math.min(1, 0.6 + 0.15 * (matchCount - 1));
  const heavy = matchCount >= 1 && (confidence >= 0.6 || matchCount >= MULTI_SIGNAL_THRESHOLD);

  return { heavy, confidence, category: bestCategory, signals };
}

/** Advisory note attached to a task's description at delegation time. Never
 *  changes routing itself — see the module doc comment for why. */
export function buildHeavyWorkAdvisory(classification: WorkloadClassification): string {
  return [
    `## Heavy-work advisory (automatic, informational only)`,
    `This task looks like it may involve ${classification.category.replace(/_/g, ' ')} (matched: ${classification.signals.slice(0, 3).join('; ')}).`,
    `Consider whether this belongs in the sandbox executor (run_executor_job) instead of this normal execution — the executor gets an isolated container and up to ~55 minutes instead of the normal 10-minute execution ceiling, and heavy work there does not block this agent's other tasks.`,
  ].join('\n');
}

/** Stronger nudge injected into the conversation right before an agent about
 *  to work in-process would otherwise start heavy work. Only fires when the
 *  agent actually has the tool available — recommending a tool an agent
 *  cannot call would just be noise. */
export function buildHeavyWorkExecutionNudge(classification: WorkloadClassification): string {
  return [
    `RESOURCE ADVISORY (automatic — no human is asking). This task matches signals for ${classification.category.replace(/_/g, ' ')} (${classification.signals.slice(0, 3).join('; ')}), which is expensive/long-running work.`,
    '',
    `You have the run_executor_job tool. For genuinely heavy work (full test suites, builds, renders, repository-wide analysis, long browser automation, large data processing, lengthy integration tests), call it instead of doing the work directly here — it runs in an isolated sandbox with a much longer time budget, and orchestrating it (dispatch, then check get_executor_status) is the correct role for this execution rather than blocking on the work itself.`,
    'If this task is actually small despite the signal match, proceed normally — this is a heuristic, not a rule.',
  ].join('\n');
}
