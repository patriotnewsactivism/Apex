/**
 * Guard: an LLM capacity pause must never park the workforce past the moment
 * capacity actually returns.
 *
 * Production evidence (2026-09-04, prod SHA f4ee7fc): /health reported
 * `status: ok`, 13 agents, all idle, `llmCapacity.state: paced` with
 * `pausedProviders: ["openrouter-minimax-m3"]` and
 * `nextResumeAt: 2026-09-05T00:00:00.000Z` -- roughly 22 hours out. The agent
 * loop's shared capacity latch (`sharedCapacityResumeAtMs` in base-agent.ts)
 * only ever moved forward, so the first agent to observe that resume-at parked
 * every agent in the process until the next UTC rollover. Nothing lowered the
 * latch when capacity came back, and nothing outside the process could tell a
 * parked workforce from an idle one.
 *
 * These checks are behavioural: they drive the real exported latch functions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CI runs guards via `pnpm --filter <pkg> exec`, so cwd is a package dir.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

async function main(): Promise<void> {
  process.env.NODE_ENV = 'test';

  console.log('── Capacity latch release (behaviour) ──');

  const agentModule = (await import(
    path.join(root, 'packages/core/src/base-agent.ts')
  )) as Partial<{
    capacityPauseRemainingMs: (now?: number) => number;
    __resetCapacityLatchForTest: () => void;
    __setCapacityLatchForTest: (resumeAtMs: number) => void;
  }>;
  const {
    capacityPauseRemainingMs,
    __resetCapacityLatchForTest,
    __setCapacityLatchForTest,
  } = agentModule;

  if (
    !capacityPauseRemainingMs ||
    !__resetCapacityLatchForTest ||
    !__setCapacityLatchForTest
  ) {
    check(
      'base-agent exports a re-probeable, testable capacity latch',
      false,
      Object.keys(agentModule).filter((key) => key.includes('apacity')),
    );
    console.error('\n❌ capacity latch is not testable from outside');
    process.exit(1);
  }

  __resetCapacityLatchForTest();
  check(
    'an unpaused workforce reports no wait',
    capacityPauseRemainingMs() === 0,
  );

  const llm = (await import(
    path.join(root, 'packages/core/src/llm-client.ts')
  )) as { llmCapacityAvailableNow: (now?: number) => boolean };
  check(
    'the capacity probe is exported and answers without throwing',
    typeof llm.llmCapacityAvailableNow(Date.now()) === 'boolean',
  );

  // The production shape: one provider's pacing window carries a resume-at ~22h
  // out and latches the whole workforce. With a usable provider configured, the
  // loop must release immediately instead of sleeping until the UTC rollover.
  const usable = llm.llmCapacityAvailableNow(Date.now());
  const setAt = Date.now();
  const twentyTwoHours = setAt + 22 * 60 * 60 * 1000;
  __setCapacityLatchForTest(twentyTwoHours);

  check(
    'a fresh capacity pause cannot be re-probed away before the 5s workspace floor',
    capacityPauseRemainingMs(setAt + 1_000) > 4_000,
    capacityPauseRemainingMs(setAt + 1_000),
  );

  if (usable) {
    check(
      'a long latch releases after the minimum hold once a provider can take work again',
      capacityPauseRemainingMs(setAt + 5_100) === 0,
      capacityPauseRemainingMs(setAt + 5_100),
    );
  } else {
    // No provider is usable here, so the latch must be HONOURED -- the release
    // path must not degrade into "always resume".
    check(
      'the latch is honoured after the floor while no provider can take work',
      capacityPauseRemainingMs(setAt + 5_100) > 21 * 60 * 60 * 1000,
      capacityPauseRemainingMs(setAt + 5_100),
    );
  }
  __resetCapacityLatchForTest();

  console.log('── Capacity latch release (source) ──');
  const agentSrc = fs.readFileSync(
    path.join(root, 'packages/core/src/base-agent.ts'),
    'utf8',
  );
  const clientSrc = fs.readFileSync(
    path.join(root, 'packages/core/src/llm-client.ts'),
    'utf8',
  );
  const apiSrc = fs.readFileSync(
    path.join(root, 'packages/api-server/src/index.ts'),
    'utf8',
  );

  check(
    'the latch is re-probed rather than trusted until its timestamp passes',
    agentSrc.includes('releaseCapacityLatchIfRecovered') &&
      /capacityPauseRemainingMs\([\s\S]{0,120}releaseCapacityLatchIfRecovered/.test(
        agentSrc,
      ),
  );
  check(
    'the latch is cleared, not merely reduced, once capacity returns',
    /if \(llmCapacityAvailableNow\(now\)\) \{\s*sharedCapacityResumeAtMs = 0;/.test(
      agentSrc,
    ),
  );
  check(
    'the re-probe is throttled so 13 agents cannot make it a hot path',
    agentSrc.includes('CAPACITY_REPROBE_INTERVAL_MS') &&
      agentSrc.includes('lastCapacityProbeAtMs'),
  );
  check(
    'the 5s minimum pause is enforced before the recovery probe may clear the latch',
    agentSrc.includes('sharedCapacityProbeNotBeforeMs') &&
      /if \(now < sharedCapacityProbeNotBeforeMs\) return;/.test(agentSrc),
  );
  check(
    'the probe reserves nothing (safe to call every poll cycle)',
    !/llmCapacityAvailableNow[\s\S]{0,1400}reserveProviderTokenCapacity/.test(
      clientSrc,
    ) &&
      !/llmCapacityAvailableNow[\s\S]{0,1400}reserveTotalTokenCapacity/.test(
        clientSrc,
      ),
  );
  check(
    'workspace caps still park capped providers without vetoing unrestricted continuity',
    /const totalDailyCapReached = isTotalDailyCapReached\(\)/.test(clientSrc) &&
      /!provider\.unrestricted[\s\S]{0,220}totalDailyCapReached/.test(clientSrc),
  );
  check(
    'one paced or capped provider does not veto capacity when another route can take work',
    clientSrc.includes('for (const providerName of activeOrder)') &&
      /if \(!requestWindowForProvider\(provider, now\)\.allowed\) continue;/.test(clientSrc) &&
      /return true;[\s\S]{0,80}\}\s*return false;/.test(clientSrc),
  );
  check(
    'authenticated health detail distinguishes a parked workforce from an idle one',
    apiSrc.includes('workforceParkedUntil') &&
      apiSrc.includes('capacityPauseRemainingMs()'),
  );

  if (failures > 0) {
    console.error(`\n❌ ${failures} capacity latch check(s) failed`);
    process.exit(1);
  }
  console.log('✅ ALL CAPACITY LATCH GUARDS PASSED');
}

void main().then(
  () => {},
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
