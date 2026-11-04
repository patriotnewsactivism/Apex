// Mints a short-lived Anam session token for the webinar's interactive video host.
// The API key never reaches the browser; the client streams with @anam-ai/js-sdk.
export type AnamEnv = Record<string, string | undefined>;

export function webinarAvatarProvider(env: AnamEnv = process.env): 'anam' | 'tavus' {
  return String(env.AVATAR_PROVIDER ?? '').trim().toLowerCase() === 'tavus' ? 'tavus' : 'anam';
}

export async function createAnamSessionToken(
  env: AnamEnv = process.env,
  request: typeof fetch = fetch,
): Promise<string> {
  const apiKey = env.ANAM_API_KEY;
  const avatarId = env.ANAM_AVATAR_ID;
  if (!apiKey || !avatarId) throw new Error('Anam is not configured (ANAM_API_KEY / ANAM_AVATAR_ID).');
  const personaConfig: Record<string, string> = {
    name: env.ANAM_PERSONA_NAME || 'Marcus Cole',
    avatarId,
  };
  if (env.ANAM_VOICE_ID) personaConfig.voiceId = env.ANAM_VOICE_ID;
  if (env.ANAM_LLM_ID) personaConfig.llmId = env.ANAM_LLM_ID;
  if (env.ANAM_SYSTEM_PROMPT) personaConfig.systemPrompt = env.ANAM_SYSTEM_PROMPT;
  const response = await request(new URL('/v1/auth/session-token', env.ANAM_API_BASE || 'https://api.anam.ai'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ personaConfig }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Anam session token request failed (${response.status}).`);
  const { sessionToken } = (await response.json()) as { sessionToken?: unknown };
  if (typeof sessionToken !== 'string' || !sessionToken) throw new Error('Anam returned no session token.');
  return sessionToken;
}
