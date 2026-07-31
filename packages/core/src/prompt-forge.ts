/**
 * Prompt Forge — meta-prompt optimization module.
 *
 * Generates a candidate prompt for a given goal/situation, critiques it on
 * three axes (clarity/specificity, task-success-rate, persona-match), test-
 * drives it against a live model, and refines across generations until the
 * score plateaus (2 flat generations) or maxIterations is hit.
 *
 * Reuses Apex's own createLLMClient/getDefaultLLMConfig — no separate HTTP
 * plumbing, so it inherits Apex's existing live provider fallback chain
 * (Cerebras -> Groq -> Cohere -> Mistral -> OpenRouter-free) automatically.
 *
 * Usage (from another Apex module or agent):
 *   import { optimizePrompt } from './prompt-forge';
 *   const result = await optimizePrompt({
 *     goalDescription: 'System prompt for the QA Director agent',
 *     targetPersona: 'meticulous, evidence-driven QA lead',
 *     maxIterations: 8,
 *   });
 */
import { createLLMClient, getDefaultLLMConfig } from './llm-client';
import type { LLMMessage } from './types';

export interface OptimizePromptInput {
  goalDescription: string;
  targetPersona?: string;
  testCases?: string[];
  maxIterations?: number;
  /** Which Apex role's default LLM config to borrow for generation/critique calls. */
  role?: string;
}

export interface PromptCandidateResult {
  generation: number;
  promptText: string;
  selfCritique: string;
  clarityScore: number;
  successRateScore: number;
  personaMatchScore: number;
  totalScore: number;
  testOutput: string;
}

export interface OptimizePromptResult {
  status: 'converged' | 'failed';
  goalDescription: string;
  targetPersona?: string;
  iterationsRun: number;
  scoreTrajectory: Array<{ generation: number; totalScore: number }>;
  bestCandidate: PromptCandidateResult | null;
  fullTrajectory: PromptCandidateResult[];
}

async function callClient(role: string, messages: LLMMessage[]): Promise<string | null> {
  try {
    const client = createLLMClient(getDefaultLLMConfig(role));
    const res = await client.complete(messages);
    return res.content;
  } catch (err) {
    return null;
  }
}

function extractJson(text: string): any | null {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const parts = cleaned.split('```');
    cleaned = parts[1]?.replace(/^json\s*/i, '') ?? cleaned;
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function generateCandidate(
  role: string,
  goal: string,
  persona: string | undefined,
  priorCritique: string | undefined,
): Promise<string | null> {
  const sys =
    'You are an expert prompt engineer. Write ONLY the final prompt text itself, ' +
    'no preamble, no markdown fences, no explanation. Ready to paste directly into ' +
    "an LLM's system/instruction field.";
  let user = `Goal/situation: ${goal}\n`;
  if (persona) user += `Target persona/style the prompt must produce: ${persona}\n`;
  if (priorCritique) user += `\nPrevious attempt's weaknesses to fix:\n${priorCritique}\n`;
  user += '\nWrite the best possible prompt for this.';
  return callClient(role, [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]);
}

async function critiqueAndScore(
  role: string,
  goal: string,
  persona: string | undefined,
  candidateText: string,
  testOutput: string,
): Promise<{ clarity_score: number; success_rate_score: number; persona_match_score: number; critique: string } | null> {
  const sys =
    'You are a rigorous prompt-quality evaluator. Score the CANDIDATE PROMPT (not the ' +
    'test output) on three axes, 0-10 each: clarity_score (specificity, lack of ambiguity), ' +
    'success_rate_score (did the test output actually achieve the goal), persona_match_score ' +
    '(does the prompt drive outputs matching the target persona, 10 if none specified). ' +
    'Respond ONLY with valid JSON: {"clarity_score": N, "success_rate_score": N, ' +
    '"persona_match_score": N, "critique": "specific weaknesses and how to fix them"}';
  const user = `Goal: ${goal}\nTarget persona: ${persona ?? 'none specified'}\n\nCANDIDATE PROMPT:\n${candidateText}\n\nTEST OUTPUT IT PRODUCED:\n${testOutput}`;
  const text = await callClient(role, [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]);
  if (!text) return null;
  return extractJson(text);
}

export async function optimizePrompt(input: OptimizePromptInput): Promise<OptimizePromptResult> {
  const role = input.role ?? 'LEAD_DEV';
  const maxIterations = input.maxIterations ?? 8;
  const trajectory: PromptCandidateResult[] = [];
  let priorCritique: string | undefined;
  let best: PromptCandidateResult | null = null;
  let plateauCount = 0;

  for (let gen = 0; gen < maxIterations; gen++) {
    const candidateText = await generateCandidate(role, input.goalDescription, input.targetPersona, priorCritique);
    if (!candidateText) break;

    const testCase = input.testCases?.[0] ?? input.goalDescription;
    const testOutput =
      (await callClient(role, [
        { role: 'system', content: candidateText },
        { role: 'user', content: testCase },
      ])) ?? '[test-drive failed all providers]';

    const scores = await critiqueAndScore(role, input.goalDescription, input.targetPersona, candidateText, testOutput);
    if (!scores) break;

    const totalScore =
      Math.round(((scores.clarity_score + scores.success_rate_score + scores.persona_match_score) / 3) * 100) / 100;

    const entry: PromptCandidateResult = {
      generation: gen,
      promptText: candidateText,
      selfCritique: scores.critique,
      clarityScore: scores.clarity_score,
      successRateScore: scores.success_rate_score,
      personaMatchScore: scores.persona_match_score,
      totalScore,
      testOutput,
    };
    trajectory.push(entry);

    if (!best || totalScore > best.totalScore) {
      best = entry;
      plateauCount = 0;
    } else {
      plateauCount++;
    }
    priorCritique = scores.critique;

    if (plateauCount >= 2) break;
  }

  return {
    status: best ? 'converged' : 'failed',
    goalDescription: input.goalDescription,
    targetPersona: input.targetPersona,
    iterationsRun: trajectory.length,
    scoreTrajectory: trajectory.map((t) => ({ generation: t.generation, totalScore: t.totalScore })),
    bestCandidate: best,
    fullTrajectory: trajectory,
  };
}

/** Lighter single-shot evaluation of an already-written prompt, no generation loop. */
export async function evaluateCandidate(
  goalDescription: string,
  promptText: string,
  targetPersona?: string,
  role = 'LEAD_DEV',
): Promise<{ clarityScore: number; successRateScore: number; personaMatchScore: number; totalScore: number; critique: string } | null> {
  const testOutput =
    (await callClient(role, [
      { role: 'system', content: promptText },
      { role: 'user', content: goalDescription },
    ])) ?? '[test-drive failed all providers]';
  const scores = await critiqueAndScore(role, goalDescription, targetPersona, promptText, testOutput);
  if (!scores) return null;
  const totalScore =
    Math.round(((scores.clarity_score + scores.success_rate_score + scores.persona_match_score) / 3) * 100) / 100;
  return {
    clarityScore: scores.clarity_score,
    successRateScore: scores.success_rate_score,
    personaMatchScore: scores.persona_match_score,
    totalScore,
    critique: scores.critique,
  };
}
