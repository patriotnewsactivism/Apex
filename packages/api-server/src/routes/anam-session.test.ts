import { describe, expect, it, vi } from 'vitest';
import { createAnamSessionToken, webinarAvatarProvider } from './anam-session.js';

describe('webinar avatar provider', () => {
  it('defaults to anam and only uses tavus when flagged', () => {
    expect(webinarAvatarProvider({})).toBe('anam');
    expect(webinarAvatarProvider({ AVATAR_PROVIDER: 'TAVUS' })).toBe('tavus');
  });

  it('requires an Anam key and avatar', async () => {
    await expect(createAnamSessionToken({}, vi.fn())).rejects.toThrow(/not configured/);
  });

  it('exchanges the API key for a session token server-side', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionToken: 'tok' }), { status: 200 }));
    const token = await createAnamSessionToken({ ANAM_API_KEY: 'k', ANAM_AVATAR_ID: 'a' }, request as unknown as typeof fetch);
    expect(token).toBe('tok');
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe('https://api.anam.ai/v1/auth/session-token');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body).personaConfig).toEqual({ name: 'Marcus Cole', avatarId: 'a' });
  });
});
