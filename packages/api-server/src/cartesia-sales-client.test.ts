import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cartesiaSalesSpokenName,
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

describe('configured sales voice override', () => {
  beforeEach(() => {
    vi.stubEnv('CARTESIA_API_KEY', 'test-key');
    clearCartesiaSalesResolutionCache();
  });
  afterEach(() => {
    clearCartesiaSalesResolutionCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function mockConfiguredVoice(configuredVoiceId: string, voice: Record<string, unknown>) {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/agents') {
        return Response.json({ data: [{ id: 'agent_test', name: 'APEX Sales — BuildMyBot' }] });
      }
      if (path === '/v1/agents/agent_test') {
        return Response.json({ config: { audio: { output: { voice_id: configuredVoiceId } } } });
      }
      if (path.startsWith('/voices/')) return Response.json(voice);
      if (path === '/voices') {
        throw new Error('the owned-voice name search must not run when CARTESIA_SALES_VOICE_ID is set');
      }
      throw new Error(`Unexpected Cartesia request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('serves a configured voice that is NOT an owned clone', async () => {
    // Regression: the configured id used to be filtered back through the owned
    // "Don Matthews" name search, so a library voice never matched, the resolve
    // threw, and the line kept dialing on the previous voice.
    vi.stubEnv('CARTESIA_SALES_VOICE_ID', 'voice_daniel');
    const fetchMock = mockConfiguredVoice('voice_daniel', {
      id: 'voice_daniel', name: 'Daniel', status: 'active', is_owner: false,
    });
    expect(await resolveCartesiaSalesAgentId()).toBe('agent_test');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refuses a configured voice that does not resolve, or is not active', async () => {
    vi.stubEnv('CARTESIA_SALES_VOICE_ID', 'voice_nope');
    mockConfiguredVoice('voice_nope', { name: 'no id here' });
    await expect(resolveCartesiaSalesAgentId()).rejects.toThrow('was not found');

    clearCartesiaSalesResolutionCache();
    mockConfiguredVoice('voice_retired', { id: 'voice_retired', name: 'Daniel', status: 'retired' });
    await expect(resolveCartesiaSalesAgentId()).rejects.toThrow('not an active voice');
  });
});

describe('sales agent spoken name', () => {
  it('defaults to Daniel and takes a configured name', () => {
    expect(cartesiaSalesSpokenName({})).toBe('Daniel');
    expect(cartesiaSalesSpokenName({ CARTESIA_SALES_SPOKEN_NAME: '  Riley  ' })).toBe('Riley');
    expect(cartesiaSalesSpokenName({ CARTESIA_SALES_SPOKEN_NAME: '   ' })).toBe('Daniel');
  });
});
