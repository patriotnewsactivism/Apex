/**
 * Why Apex Copilot is (or is not) usable in this browser.
 *
 * There are three answers, not two, and conflating the last two is what made
 * Copilot vanish on a phone without a word:
 *
 *   off           — the feature is not enabled for this deployment, or the
 *                   status call failed for a reason the operator cannot act on.
 *                   Render nothing.
 *   ready         — enabled and this device holds a valid operator session.
 *                   Render the toggle.
 *   needs-sign-in — enabled, but this device holds NO valid operator dashboard
 *                   session, so `/chat/copilot/status` answers 403.
 *
 * `needs-sign-in` is the state that matters. The operator session is a
 * deliberate second credential, minted only by a dashboard password login and
 * good for 12 hours, because the admin bearer token alone must never be enough
 * to authorize an outbound send. The dashboard's own gate only checks that
 * bearer, so a browser can be fully "logged in" — every panel loading real data
 * — while holding no operator session at all. That is the normal state of a
 * phone that logged in before operator sessions existed: its long-lived token
 * still validates, so it is never asked to sign in again, and the Copilot
 * toggle simply never rendered. Desktop looked fine because it had a fresh
 * session.
 *
 * The client must not try to mint its way out of this. Only the password login
 * mints an operator session, by design; that is the whole point of the
 * separate credential. So the fix is to say so out loud and offer the one
 * action that works — sign in again — rather than hiding the feature.
 */

export type CopilotAvailability = 'off' | 'ready' | 'needs-sign-in';

export interface CopilotAvailabilityInput {
  /** `VITE_FEATURE_COPILOT` — the build-time gate that controls visibility. */
  clientFlagEnabled: boolean;
  /** Body of `GET /api/chat/copilot/status`, or undefined while loading/errored. */
  status: { enabled?: boolean } | undefined;
  /** HTTP status of the failed status call, or null when it did not fail. */
  errorStatus: number | null;
}

/** The 403 that `/chat/copilot/status` answers when the operator session is missing or expired. */
export const COPILOT_OPERATOR_SESSION_REQUIRED = 403;

export function resolveCopilotAvailability(input: CopilotAvailabilityInput): CopilotAvailability {
  if (!input.clientFlagEnabled) return 'off';
  if (input.status?.enabled === true) return 'ready';
  if (input.errorStatus === COPILOT_OPERATOR_SESSION_REQUIRED) return 'needs-sign-in';
  // Loading, a network fault, or a 5xx: say nothing. A transient failure must
  // not tell the operator to sign in when signing in is not the problem.
  return 'off';
}
