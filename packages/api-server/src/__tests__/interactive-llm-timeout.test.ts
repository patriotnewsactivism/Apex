import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The interactive timeout cap is only worth anything if EVERY dispatch path
 * receives the execution context. A call site that drops it silently reverts to
 * the 30s agent budget and the operator waits in front of a frozen chat again —
 * with no error to notice. That silent-reversion is what these checks guard.
 */
const source = readFileSync(new URL('../../../core/src/llm-client.ts', import.meta.url), 'utf8');

describe('interactive request timeout', () => {
  it('is env-tunable and well under the background default', () => {
    const match = source.match(
      /const INTERACTIVE_REQUEST_TIMEOUT_MS = envPositiveInt\(\s*'([A-Z_]+)',\s*([\d_]+),?\s*\)/,
    );
    expect(match, 'INTERACTIVE_REQUEST_TIMEOUT_MS must stay env-tunable').not.toBeNull();
    expect(match?.[1]).toBe('APEX_LLM_INTERACTIVE_TIMEOUT_MS');
    const ms = Number(match?.[2].replace(/_/g, ''));
    expect(ms).toBeGreaterThan(0);
    // Must be a real cut against the 30s LLM_REQUEST_TIMEOUT_MS default, or it
    // changes nothing for the operator.
    expect(ms).toBeLessThan(30_000);
  });

  it('caps the timeout only for interactive turns', () => {
    expect(source).toMatch(/if \(execution\?\.interactive\) return Math\.min\(base, INTERACTIVE_REQUEST_TIMEOUT_MS\);/);
  });

  it('passes the execution context on every provider dispatch', () => {
    // Both timed dispatch paths — the OpenAI-compatible call and the Gemini
    // interactions call — must carry `execution` into the timeout.
    const withExecution = source.match(/providerRequestTimeoutMs\(provider, execution\)/g) ?? [];
    expect(withExecution.length).toBe(2);
    // And no timed call site may be left without it.
    expect(source).not.toMatch(/setTimeout\(\(\) => controller\.abort\(\), providerRequestTimeoutMs\(provider\)\)/);
  });
});
