// Regression guard for the agent dashboard model/provider display bug.
//
// Root cause (two parts):
// 1. Every production agent class hardcoded a stale, pre-Qwen `llm: {...}`
//    literal in its constructor, which unconditionally beat the live,
//    role-derived default from getDefaultLLMConfig() (Qwen-first, ADR-017).
// 2. base-agent.ts's initialize() wrote `this.config.llm.model/provider` —
//    the raw, unmerged override — to the `agents` DB table that feeds
//    ControlRoom.tsx/AgentNetwork.tsx, instead of the merged, actually-
//    effective `this.llmConfig`.
//
// Actual dispatch was never affected (activeProviderOrder() only reads
// `role`, never config.provider/config.model) — this guard exists purely to
// keep the *displayed* model honest, and to stop a future agent file from
// reintroducing a literal that goes stale the next time routing policy
// changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultLLMConfig } from '../packages/core/src/llm-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

// ── 1. No production agent file hardcodes an llm override literal ─────────
console.log('── No hardcoded llm overrides in production agent classes ──');
const agentsSrcDir = path.join(repoRoot, 'packages/agents/src');
const agentFiles = fs
  .readdirSync(agentsSrcDir)
  .filter((f) => f.endsWith('.ts'))
  .sort();

check('found the expected set of production agent source files', agentFiles.length >= 7, agentFiles);

for (const file of agentFiles) {
  const full = path.join(agentsSrcDir, file);
  const raw = fs.readFileSync(full, 'utf8');
  // Strip line comments before matching so an explanatory comment (e.g.
  // "// No llm override: ...") can never itself trip the check.
  const withoutComments = raw
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const hasHardcodedOverride = /\bllm\s*:\s*\{/.test(withoutComments);
  check(`${file} omits llm override (derives live from getDefaultLLMConfig)`, !hasHardcodedOverride);
}

// ── 2. AgentConfig.llm stays optional ──────────────────────────────────────
console.log('── AgentConfig.llm is optional ──');
const typesSrc = fs.readFileSync(path.join(repoRoot, 'packages/core/src/types.ts'), 'utf8');
const agentConfigMatch = typesSrc.match(/interface AgentConfig \{[\s\S]*?\n\}/);
check('AgentConfig interface found in types.ts', !!agentConfigMatch);
if (agentConfigMatch) {
  check(
    'AgentConfig.llm is declared optional (llm?:)',
    /\bllm\?\s*:\s*LLMClientConfig/.test(agentConfigMatch[0]),
  );
  check(
    'AgentConfig.llm is not declared required (llm:)',
    !/\bllm\s*:\s*LLMClientConfig/.test(agentConfigMatch[0]),
  );
}

// ── 3. base-agent.ts writes the merged config, not the raw override ───────
console.log('── base-agent.ts persists the merged llmConfig, not the raw override ──');
const baseAgentSrc = fs.readFileSync(path.join(repoRoot, 'packages/core/src/base-agent.ts'), 'utf8');
check(
  'constructor derives this.llmConfig from getDefaultLLMConfig(role) merged with config.llm',
  /this\.llmConfig\s*=\s*\{\s*\.\.\.getDefaultLLMConfig\(config\.role\),\s*\.\.\.config\.llm,?\s*\}/.test(baseAgentSrc),
);
check(
  'createLLMClient is constructed from the merged this.llmConfig',
  /createLLMClient\(this\.llmConfig\)/.test(baseAgentSrc),
);
check(
  'initialize() DB upsert reads model from this.llmConfig',
  /model:\s*this\.llmConfig\.model/.test(baseAgentSrc),
);
check(
  'initialize() DB upsert reads provider from this.llmConfig',
  /provider:\s*this\.llmConfig\.provider/.test(baseAgentSrc),
);
check(
  'initialize() never reads the raw, unmerged config.llm.model/provider',
  !/this\.config\.llm\.(model|provider)/.test(baseAgentSrc),
);

// Precise check on the onConflictDoUpdate's own `set` object -- a looser
// whole-file substring match for "model: this.llmConfig.model" would also
// match the insert-only values() block and miss a regression where an
// existing agent row (i.e. every agent after the very first boot) never
// gets its model/provider refreshed on restart, only on that agent's next
// actual LLM call via persistActualProvider().
const onConflictIdx = baseAgentSrc.indexOf('onConflictDoUpdate(');
check('initialize() DB upsert has an onConflictDoUpdate call', onConflictIdx !== -1);
if (onConflictIdx !== -1) {
  const setIdx = baseAgentSrc.indexOf('set: {', onConflictIdx);
  check('onConflictDoUpdate call has a set object', setIdx !== -1);
  if (setIdx !== -1) {
    let depth = 0;
    let end = setIdx;
    for (let i = setIdx + 'set: {'.length - 1; i < baseAgentSrc.length; i++) {
      if (baseAgentSrc[i] === '{') depth++;
      else if (baseAgentSrc[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const setBlock = baseAgentSrc.slice(setIdx, end + 1);
    check(
      'onConflictDoUpdate refreshes model on an existing agent row, not just status/lastActiveAt',
      /model:\s*this\.llmConfig\.model/.test(setBlock),
      setBlock,
    );
    check(
      'onConflictDoUpdate refreshes provider on an existing agent row, not just status/lastActiveAt',
      /provider:\s*this\.llmConfig\.provider/.test(setBlock),
      setBlock,
    );
  }
}

// ── 4. Functional merge semantics: default flows through, override wins ──
console.log('── getDefaultLLMConfig() merge semantics (constructor behavior) ──');
const representativeRoles = [
  'CEO', 'CTO', 'COO', 'LEAD_DEV', 'FRONTEND', 'BACKEND', 'DEVOPS', 'QA',
  'LEAD_RESEARCH', 'SALES', 'MARKETING', 'CUSTOMER_SUCCESS', 'QA_DIRECTOR',
];

for (const role of representativeRoles) {
  const liveDefault = getDefaultLLMConfig(role);
  // Simulates exactly what BaseAgent's constructor does: { ...default, ...override }
  const mergedWithNoOverride = { ...getDefaultLLMConfig(role), ...(undefined as unknown as object) };
  check(
    `${role}: no override -> merged config matches the live default exactly`,
    mergedWithNoOverride.model === liveDefault.model &&
      mergedWithNoOverride.provider === liveDefault.provider &&
      mergedWithNoOverride.maxTokens === liveDefault.maxTokens,
    mergedWithNoOverride,
  );

  const deliberateOverride = { model: `test-override-model-${role}`, provider: 'test-override-provider' };
  const mergedWithOverride = { ...getDefaultLLMConfig(role), ...deliberateOverride };
  check(
    `${role}: an explicit override (the escape hatch AgentConfig.llm still allows) wins over the live default`,
    mergedWithOverride.model === deliberateOverride.model && mergedWithOverride.provider === deliberateOverride.provider,
    mergedWithOverride,
  );
}

// Sanity: getDefaultLLMConfig is genuinely role-sensitive (token budget),
// not a constant a future refactor could collapse back into a shared literal.
check(
  'getDefaultLLMConfig is role-sensitive (leadership vs. specialist token budgets differ)',
  getDefaultLLMConfig('CEO').maxTokens !== getDefaultLLMConfig('FRONTEND').maxTokens,
  { CEO: getDefaultLLMConfig('CEO').maxTokens, FRONTEND: getDefaultLLMConfig('FRONTEND').maxTokens },
);

console.log('');
if (failures > 0) {
  console.error(`❌ verify-agent-model-display: ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('✅ verify-agent-model-display: all checks passed');
}
