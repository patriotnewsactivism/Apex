import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COPILOT_HARD_DENY_ACTIONS,
  isCopilotChatToolAllowed,
  isCopilotFeatureEnabled,
  validateCopilotAction,
} from '../copilot-actions.js';
import { isCopilotClientFeatureEnabled } from '../../../dashboard/src/copilot/feature-flag.js';
import {
  COPILOT_OPERATOR_SESSION_REQUIRED,
  resolveCopilotAvailability,
} from '../../../dashboard/src/copilot/availability.js';

describe('Apex Copilot feature flag', () => {
  it('is off by default and accepts only an explicit true value', () => {
    expect(isCopilotFeatureEnabled({})).toBe(false);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: 'false' })).toBe(false);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: '1' })).toBe(false);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: 'true' })).toBe(true);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: ' TRUE ' })).toBe(true);
  });

  it('keeps the dashboard toggle hidden unless the Vite flag is explicitly true', () => {
    expect(isCopilotClientFeatureEnabled(undefined)).toBe(false);
    expect(isCopilotClientFeatureEnabled('false')).toBe(false);
    expect(isCopilotClientFeatureEnabled('1')).toBe(false);
    expect(isCopilotClientFeatureEnabled('true')).toBe(true);
  });

  it('requires the password-minted operator session on every Copilot API path', () => {
    const chatSource = readFileSync(new URL('../routes/chat.ts', import.meta.url), 'utf8');
    expect(chatSource).toContain("router.get('/copilot/status', async");
    expect(chatSource).toContain("router.post('/copilot/audit', async");
    expect(chatSource).toContain("router.post('/copilot/session-audit', async");
    expect(
      chatSource.match(/requireCopilotOperatorSession\(req, res\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('Apex Copilot dashboard availability', () => {
  // The regression this guards: a phone whose stored login predates operator
  // sessions is fully "logged in" (its long-lived bearer still validates) but
  // holds no operator session, so /chat/copilot/status answers 403. The client
  // treated that as "feature unavailable" and rendered no control at all, so
  // Copilot was silently missing on that device with nothing to act on.
  const base = { clientFlagEnabled: true, status: undefined, errorStatus: null };

  it('is off when the build-time flag is off, whatever the server says', () => {
    expect(resolveCopilotAvailability({ ...base, clientFlagEnabled: false })).toBe('off');
    expect(
      resolveCopilotAvailability({ ...base, clientFlagEnabled: false, status: { enabled: true } }),
    ).toBe('off');
  });

  it('is ready only on an explicit enabled status', () => {
    expect(resolveCopilotAvailability({ ...base, status: { enabled: true } })).toBe('ready');
    expect(resolveCopilotAvailability({ ...base, status: { enabled: false } })).toBe('off');
    expect(resolveCopilotAvailability({ ...base, status: {} })).toBe('off');
  });

  it('asks for a sign-in on the operator-session 403, and only that status', () => {
    expect(
      resolveCopilotAvailability({ ...base, errorStatus: COPILOT_OPERATOR_SESSION_REQUIRED }),
    ).toBe('needs-sign-in');
    // A transient fault must not send the operator to a login form.
    for (const errorStatus of [null, 401, 404, 500, 502, 503]) {
      expect(resolveCopilotAvailability({ ...base, errorStatus })).toBe('off');
    }
  });
});

describe('Apex Copilot action registry', () => {
  it('accepts only the scoped dashboard actions', () => {
    expect(validateCopilotAction({ type: 'navigate', page: 'contacts' })).toEqual({
      ok: true,
      action: { type: 'navigate', page: 'contacts' },
    });
    expect(validateCopilotAction({
      type: 'setFilter', page: 'leads', field: 'status', value: 'qualified',
    }).ok).toBe(true);
    expect(validateCopilotAction({
      type: 'setFilter', page: 'contacts', field: 'doNotContact', value: true,
    }).ok).toBe(false);
  });

  it.each(COPILOT_HARD_DENY_ACTIONS)('hard-denies %s', (type) => {
    const result = validateCopilotAction({ type });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('denied');
  });

  it('rejects unknown and sensitive destinations', () => {
    expect(validateCopilotAction({ type: 'click', selector: '#anything' }).ok).toBe(false);
    expect(validateCopilotAction({ type: 'navigate', page: 'settings' }).ok).toBe(false);
    expect(validateCopilotAction({ type: 'navigate', page: 'pending-sends' }).ok).toBe(false);
  });

  it('does not execute hidden mutating chat tools while Copilot is active', () => {
    expect(isCopilotChatToolAllowed('control_dashboard')).toBe(true);
    expect(isCopilotChatToolAllowed('get_recent_goals')).toBe(true);
    expect(isCopilotChatToolAllowed('create_goal')).toBe(false);
    expect(isCopilotChatToolAllowed('approve_pending_approval')).toBe(false);
    expect(isCopilotChatToolAllowed('cancel_goal')).toBe(false);
  });
});
