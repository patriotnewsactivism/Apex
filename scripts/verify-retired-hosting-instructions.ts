// ─── Guard: retired hosting paths must never read as current instructions ────
//
// APEX production is the Railway service `apex-backend` behind
// https://apex.donmatthews.live, built from the repository Dockerfile
// (railway.toml). AWS Lightsail/CodeBuild are retired APEX hosting paths
// (AGENTS.md → "Current production runtime", docs/ARCHITECTURE_DECISIONS.md).
//
// RAILWAY WAS REMOVED FROM THIS LIST ON 2026-09-15, and the reason matters more
// than the edit. Cloud Run stopped serving when billing was disabled on project
// apex-503709: every route returned 503 and the image push was denied outright.
// The cutover in docs/HOSTING_MIGRATION.md was executed, so the sentence this
// guard used to enforce — "Railway is not the current APEX production host" —
// is now the dangerous one. A guard that pins the wrong host is worse than no
// guard: it fails CI for telling the truth.
//
// Cloud Run is deliberately NOT added to the retired set. It is an unbilled
// standby, .github/workflows/deploy.yml still describes the tested way back,
// and most surviving mentions are history rather than instruction. Line-level
// pattern matching cannot tell those apart, so the current-host declarations
// are asserted positively below instead.
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

const RETIRED_HOST = /\b(lightsail|codebuild)\b/i;

/** Words that make a line unmistakably historical or prohibitive. */
const RETIREMENT_MARKER =
  /\b(retired|historical|history|legacy|former|formerly|deprecated|removed|no longer|not a|never|do not|must not|cannot|is not|are not|prior|old)\b/i;

/** Surfaces an agent reads before touching production, and the declaration it
 *  must find there. Cloud Run answered 503 for hours on 2026-09-14 while every
 *  one of these files still named it as the live host. */
const CURRENT_HOST_DECLARATIONS = [
  'AGENTS.md',
  'README.md',
  'docs/HOSTING_MIGRATION.md',
];

export function checkRetiredHostingInstructions(): number {
  let failures = 0;
  console.log('── Retired hosting instructions guard ──');

  for (const rel of CURRENT_HOST_DECLARATIONS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    // Naming Railway is not enough — every one of these files named it before
    // the cutover too, as the thing NOT to deploy. So the assertion is scoped to
    // a single LINE that ties Railway to serving production, and that line must
    // not be a negation. "Railway is not the current APEX production host" has
    // to fail this check, or the guard passes on the sentence it exists to catch.
    const namesRailwayAsProduction = fs
      .readFileSync(abs, 'utf8')
      .split('\n')
      .some(
        (line) =>
          /\brailway\b/i.test(line) &&
          /\b(production|current|live|serves|hosts|runs on)\b/i.test(line) &&
          !/\b(not|never|no longer|must not|do not|cannot|planned|eventual|future|proposed)\b/i.test(
            line,
          ),
      );
    if (!namesRailwayAsProduction) {
      failures++;
      console.error(
        `  ❌ ${rel} does not declare Railway as the current APEX production host`,
      );
    }
  }

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
