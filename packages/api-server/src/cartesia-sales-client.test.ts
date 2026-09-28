import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCartesiaSalesResolutionCache,
  resolveCartesiaSalesAgentId,
} from '@workspace/core';

describe('canonical Cartesia sales voice', () => {
  beforeEach(() => {
    vi.stubEnv('CARTESIA_API_KEY', 'test-key');
    vi.stubEnv('CARTESIA_SALES_VOICE_ID', '');
    clearCartesiaSalesResolutionCache();
  });
  afterEach(() => {
    clearCartesiaSalesResolutionCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function mockCartesia(voiceId: string | null, configuredVoiceId = voiceId) {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/agents') {
        return Response.json({ data: [{ id: 'agent_test', name: 'APEX Sales — BuildMyBot' }] });
      }
      if (path === '/v1/agents/agent_test') {
        return Response.json({ config: { audio: { output: { voice_id: configuredVoiceId } } } });
      }
      if (path === '/voices') {
        return Response.json({ data: voiceId ? [{
          id: voiceId, name: 'Don Matthews', status: 'active', is_owner: true,
        }] : [], has_more: false });
      }
      throw new Error(`Unexpected Cartesia request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('accepts only the owned Don Matthews voice on the canonical agent', async () => {
    const fetchMock = mockCartesia('voice_don');
    expect(await resolveCartesiaSalesAgentId()).toBe('agent_test');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await resolveCartesiaSalesAgentId()).toBe('agent_test');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('blocks a generic voice and does not cache the agent', async () => {
    const fetchMock = mockCartesia('voice_don', 'voice_generic');
    await expect(resolveCartesiaSalesAgentId()).rejects.toThrow('dialing is blocked');
    await expect(resolveCartesiaSalesAgentId()).rejects.toThrow('dialing is blocked');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('blocks dialing when the owned voice cannot be found', async () => {
    mockCartesia(null, 'voice_generic');
    await expect(resolveCartesiaSalesAgentId()).rejects.toThrow('not available');
  });
});
