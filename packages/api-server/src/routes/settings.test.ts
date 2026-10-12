import { afterEach, describe, expect, it } from 'vitest';
import { probeTargetUrl } from './settings.js';

const WORKSPACE = 'https://ws-2hoz39gy9u9ambrw.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
const KEY_SCOPED_ENVS = ['QWEN_BASE_URL', 'APEX_QWEN_BASE_URL'];

afterEach(() => {
  for (const key of KEY_SCOPED_ENVS) delete process.env[key];
});

describe('integration probe endpoints', () => {
  it('leaves fixed providers on their compiled endpoint', () => {
    process.env.QWEN_BASE_URL = WORKSPACE;
    expect(probeTargetUrl('OPENROUTER_API_KEY')).toBe('https://openrouter.ai/api/v1/models');
  });

  it('follows the configured workspace endpoint for a key-scoped provider', () => {
    process.env.QWEN_BASE_URL = WORKSPACE;
    expect(probeTargetUrl('QWEN_API_KEY')).toBe(`${WORKSPACE}/models`);
    expect(probeTargetUrl('QWEN_API_KEY_2')).toBe(`${WORKSPACE}/models`);
  });

  it('falls back to APEX_QWEN_BASE_URL, then to the compiled default', () => {
    const alt = 'https://ws-altexample.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    process.env.APEX_QWEN_BASE_URL = alt;
    expect(probeTargetUrl('QWEN_API_KEY')).toBe(`${alt}/models`);

    // A blank override is not a value: routing skips it, so the probe must too.
    process.env.QWEN_BASE_URL = '   ';
    expect(probeTargetUrl('QWEN_API_KEY')).toBe(`${alt}/models`);

    delete process.env.APEX_QWEN_BASE_URL;
    expect(probeTargetUrl('QWEN_API_KEY')).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models');
  });

  it('normalizes trailing slashes and a base that already names the chat route', () => {
    process.env.QWEN_BASE_URL = `${WORKSPACE}/chat/completions/`;
    expect(probeTargetUrl('QWEN_API_KEY')).toBe(`${WORKSPACE}/models`);
  });

  it('returns null for an integration with no live probe', () => {
    expect(probeTargetUrl('STRIPE_SECRET_KEY')).toBeNull();
  });
});
