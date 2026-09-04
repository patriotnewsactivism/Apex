// ─── Guard: retired hosting paths must never read as current instructions ────
//
// APEX production is the existing Google Cloud Run service behind
// https://apex.donmatthews.live. AWS Lightsail/CodeBuild and Railway are
// retired APEX hosting paths (AGENTS.md → "Current production runtime",
// docs/ARCHITECTURE_DECISIONS.md).
//
// The failure this guard prevents is real and was found in
// .agents/skills/apex-autopilot/SKILL.md, which still told an agent to
// "verify active AWS Lightsail deployment" and to "inspect CodeBuild and
// Lightsail state" — instructions that directly contradict AGENTS.md and can
// send an autonomous run at infrastructure that no longer exists.
//
// Historical material is explicitly allowed: a mention only fails when it is
// NOT marked as retired/historical on the same line.

import fs from 'node:fs';
import path from 'node:path';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();

/** Instruction surfaces an agent may act on directly. */
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHECKLIST.md',
  'docs/ARCHITECTURE_DECISIONS.md',
  'docs/PRODUCTION_OPERATIONS.md',
  'docs/DURABLE_AUTONOMY_OPERATIONS.md',
  'docs/deploy-provenance.md',
  '.agents/skills/apex-autopilot/SKILL.md',
  '.agents/skills/apex-autopilot/references/runtime-contract.md',
  '.agents/skills/apex-autopilot/references/decision-protocol.md',
  '.agents/skills/apex-autopilot/references/autonomy-matrix.md',
];

const RETIRED_HOST = /\b(lightsail|codebuild|railway)\b/i;

/**
 * A mention is only exempt when the line itself marks that hosting path as
 * retired or prohibited. Deliberately narrow: vague words like "old", "prior"
 * or a bare "never" elsewhere in the sentence must NOT buy an exemption, or a
 * live instruction could smuggle itself past this guard on an unrelated
 * historical aside.
 */
const RETIREMENT_MARKER = new RegExp(
  [
    'retired',
    'historical',
    'deprecated',
    'no longer',
    'formerly',
    'former ',
    'legacy',
    'not (a|an|the)? ?(current|production|apex)',
    'must not (be )?(restore|revive|use)',
    'do not (restore|revive|use|reintroduce)',
    'never (restore|revive|reintroduce|use)',
    'is not (a|the) apex',
    'are not apex',
    'removed',
  ].join('|'),
  'i',
);

export function checkRetiredHostingInstructions(): number {
  let failures = 0;
  console.log('── Retired hosting instructions guard ──');
  for (const rel of INSTRUCTION_FILES) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!RETIRED_HOST.test(line)) return;
      if (RETIREMENT_MARKER.test(line)) return;
      failures++;
      console.error(
        `  ❌ ${rel}:${i + 1} presents a retired hosting path as current instruction: ${line.trim().slice(0, 160)}`,
      );
    });
  }
  if (failures === 0) {
    console.log('  ✅ no unmarked retired-hosting instructions in agent-facing docs');
  } else {
    console.error(
      '  Either delete the line or clearly mark it historical/retired on the same line.',
    );
  }
  return failures;
}

// Also runnable standalone: `tsx scripts/verify-retired-hosting-instructions.ts`
if (process.argv[1] && process.argv[1].endsWith('verify-retired-hosting-instructions.ts')) {
  process.exit(checkRetiredHostingInstructions() === 0 ? 0 : 1);
}
