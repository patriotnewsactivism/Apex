/** What Sell to me and practice-pitch return. `call` is absent when the
 *  request stopped before a phone job was staged — the Revenue page used to
 *  crash by reading `call.id` in that case. */
export interface RehearsalOutcomeInput {
  awaitingSafeguard?: boolean;
  email?: {
    success?: boolean;
    status?: string;
    error?: string;
  } | null;
  call?: {
    success?: boolean;
    id?: string;
    callId?: string;
    error?: string;
    awaitingSafeguard?: boolean;
  } | null;
}

/** Operator-facing summary of a rehearsal. Never reads a missing call or email. */
export function describeRehearsalOutcome(result: RehearsalOutcomeInput | null | undefined): string {
  if (!result) return 'The rehearsal did not return a result.';
  const email = result.email ?? null;
  const call = result.call ?? null;
  const emailText = !email
    ? 'Email did not start.'
    : email.error
      ? `Email: ${email.error}`
      : `Email ${email.status ?? (email.success ? 'sent' : 'not sent')}.`;
  const callId = call?.callId || call?.id || '';
  const callText = !call
    ? 'Call did not start.'
    : call.error
      ? `Call: ${call.error}`
      : callId
        ? `Call placed (${callId}).`
        : call.success
          ? 'Call placed.'
          : 'Call not started.';
  const waiting = (result.awaitingSafeguard === true || call?.awaitingSafeguard === true) && call?.success !== true;
  if (waiting) {
    return `${emailText} ${callText} Nothing was dialed yet. Open Pending sends, confirm the job twice, then release the call.`;
  }
  return `${emailText} ${callText}`;
}
