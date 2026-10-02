import { describe, expect, it, vi } from 'vitest';
import { HealthMonitor } from '../../../health-monitor/src/index.js';

const providers = () => [{ name: 'configured-route', configured: true, enabled: true }];

describe('LLM provider health', () => {
  it('reports degraded when configured routes have no usable capacity', async () => {
    const monitor = new HealthMonitor({ getConfiguredProviders: providers, llmCapacityAvailableNow: () => false });
    const result = await monitor.checkLLMProviders();
    expect(result.status).toBe('degraded');
    expect(result.detail).toMatch(/capacity.*unavailable/i);
    expect(result.detail).toContain('configured-route:configured');
    expect(result.detail).not.toContain(':ok');
  });

  it('reports healthy after capacity returns', async () => {
    let available = false;
    const monitor = new HealthMonitor({ getConfiguredProviders: providers, llmCapacityAvailableNow: () => available });
    expect((await monitor.checkLLMProviders()).status).toBe('degraded');
    available = true;
    expect((await monitor.checkLLMProviders()).status).toBe('healthy');
  });

  it('does not claim availability from key presence when no capacity source is injected', async () => {
    const result = await new HealthMonitor({ getConfiguredProviders: providers }).checkLLMProviders();
    expect(result.status).toBe('degraded');
    expect(result.detail).toMatch(/capacity.*unknown/i);
  });

  it('reports critical when no enabled provider is configured', async () => {
    const monitor = new HealthMonitor({
      getConfiguredProviders: () => [
        { name: 'missing-route', configured: false },
        { name: 'disabled-route', configured: true, enabled: false },
      ],
      llmCapacityAvailableNow: () => false,
    });
    const result = await monitor.checkLLMProviders();
    expect(result.status).toBe('critical');
    expect(result.detail).toContain('disabled-route:disabled');
    expect(result.detail).toContain('missing-route:missing');
  });

  it('preserves tool-calling degradation even when capacity is available', async () => {
    const monitor = new HealthMonitor({
      getConfiguredProviders: providers,
      llmCapacityAvailableNow: () => true,
      getDegradedToolCalling: () => ({ degraded: true, count: 2, providers: ['configured-route'], since: '2026-09-30' }),
    });
    const result = await monitor.checkLLMProviders();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('TOOL CALLING DEGRADED');
  });

  it('reports a failing capacity source without crashing the monitor', async () => {
    const monitor = new HealthMonitor({
      getConfiguredProviders: providers,
      llmCapacityAvailableNow: () => { throw new Error('capacity snapshot unavailable'); },
    });
    const result = await monitor.checkLLMProviders();
    expect(result.status).toBe('critical');
    expect(result.detail).toContain('capacity snapshot unavailable');
  });

  it('makes no network request on the fast provider-health path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const monitor = new HealthMonitor({ getConfiguredProviders: providers, llmCapacityAvailableNow: () => false });
      await monitor.checkLLMProviders();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
