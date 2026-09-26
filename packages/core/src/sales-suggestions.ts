// Operational suggestions. Each one names a fact already on the sales floor
// and a single action. They are not product ideas and they do not create goals.

export interface SalesSuggestion {
  fingerprint: string;
  title: string;
  detail: string;
  action: 'sell-to-me' | 'open-email' | 'listen' | 'resume-outbound' | 'review-imported';
  actionRef?: string;
}

export interface SalesSuggestionInput {
  policyMode: 'off' | 'rehearsal_only' | 'capped_live';
  killSwitch: boolean;
  rehearsalReady: boolean;
  rehearsalSucceeded: boolean;
  lastRehearsalError: string | null;
  liveUnjoinedCallId: string | null;
  failureGroups: Array<{ reason: string; count: number; campaignId: string | null }>;
  queuedCampaigns: number;
  importedWithEmail: number;
}

export function buildSalesSuggestions(input: SalesSuggestionInput): SalesSuggestion[] {
  const suggestions: SalesSuggestion[] = [];

  if (input.killSwitch) {
    suggestions.push({
      fingerprint: 'kill-switch-on',
      title: 'Outbound is paused',
      detail: 'The kill switch is on, so rehearsal and live sends both wait for you.',
      action: 'resume-outbound',
    });
  }

  if (!input.rehearsalSucceeded) {
    suggestions.push({
      fingerprint: `rehearsal-${input.lastRehearsalError ? 'failed' : 'never'}-${input.rehearsalReady ? 'ready' : 'incomplete'}`,
      title: input.lastRehearsalError ? 'The last rehearsal did not finish' : 'Sell to yourself once before a live list',
      detail: input.lastRehearsalError
        ?? (input.rehearsalReady
          ? 'The designed intro is ready to email and call the rehearsal profile.'
          : 'Add your email, phone, and the business you are pretending to run.'),
      action: 'sell-to-me',
    });
  }

  for (const group of input.failureGroups.slice(0, 3)) {
    const reason = group.reason.slice(0, 140);
    suggestions.push({
      fingerprint: `email-fail:${group.campaignId ?? 'none'}:${group.count}:${reason}`,
      title: `${group.count} email${group.count === 1 ? '' : 's'} failed`,
      detail: reason,
      action: 'open-email',
      actionRef: group.campaignId ?? undefined,
    });
  }

  if (input.queuedCampaigns > 0) {
    suggestions.push({
      fingerprint: `queued-campaigns:${input.queuedCampaigns}`,
      title: `${input.queuedCampaigns} campaign${input.queuedCampaigns === 1 ? '' : 's'} still have queued email`,
      detail: input.policyMode === 'off'
        ? 'Nothing sends until you approve a batch or turn on capped live mode.'
        : 'The next batch can run under the current outbound policy.',
      action: 'open-email',
    });
  }

  if (input.importedWithEmail > 0) {
    suggestions.push({
      fingerprint: `imported-unenrolled:${input.importedWithEmail}`,
      title: `${input.importedWithEmail} imported lead${input.importedWithEmail === 1 ? '' : 's'} with email are not in a campaign`,
      detail: 'They are on the lead list. Enroll them in the designed intro when you want them contacted.',
      action: 'review-imported',
    });
  }

  if (input.liveUnjoinedCallId) {
    suggestions.push({
      fingerprint: `live-call:${input.liveUnjoinedCallId}`,
      title: 'A sales call is live',
      detail: 'Listen puts your phone on the call muted. Whisper coaches the AI. Talk joins the buyer.',
      action: 'listen',
      actionRef: input.liveUnjoinedCallId,
    });
  }

  return suggestions;
}
