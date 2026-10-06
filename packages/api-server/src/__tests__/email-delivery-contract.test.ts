import { afterEach, describe, expect, it, vi } from 'vitest';
import { resendFromAddress } from '@workspace/core';

describe('email-delivery contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never defaults to a hardcoded personal domain as the sender', () => {
    vi.stubEnv('RESEND_FROM_EMAIL', '');
    vi.stubEnv('RESEND_FROM_NAME', '');
    expect(resendFromAddress()).toBeNull();
  });

  it('uses the configured verified sender when present', () => {
    vi.stubEnv('RESEND_FROM_EMAIL', 'hello@buildmybot.app');
    vi.stubEnv('RESEND_FROM_NAME', 'BuildMyBot');
    expect(resendFromAddress()).toBe('BuildMyBot <hello@buildmybot.app>');
  });
});
