// Standing permission for sales email and calls. This does not weaken deploy,
// shell, or connector gates. A null or off policy never auto-approves.

export const SALES_OUTBOUND_TOOLS = new Set([
  'send_email',
  'send_email_campaign_batch',
  'make_outbound_call',
]);

export type OutboundPolicyMode = 'off' | 'rehearsal_only' | 'capped_live';

export interface OutboundPolicySnapshot {
  mode: OutboundPolicyMode;
  killSwitch: boolean;
  rehearsalEmail: string | null;
  rehearsalPhone: string | null;
  personaName: string | null;
  personaCompany: string | null;
  personaIndustry: string | null;
  personaCity: string | null;
  dailyEmailCap: number;
  dailyCallCap: number;
  /** Local hours during which live outreach may run. Start inclusive, end exclusive. */
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  timezone: string;
  postalAddress: string | null;
  unsubscribeEmail: string | null;
  emailsSentToday: number;
  callsPlacedToday: number;
}

export interface SalesOutboundInput {
  toolName: string;
  destinationEmail?: string | null;
  destinationPhone?: string | null;
  leadId?: string | null;
  leadExists?: boolean;
  suppressed?: boolean;
  policy: OutboundPolicySnapshot | null;
  now?: Date;
}

export interface SalesOutboundDecision {
  autoApprove: boolean;
  rehearsal: boolean;
  reason: string;
}

export function emptyOutboundPolicy(): OutboundPolicySnapshot {
  return {
    mode: 'off',
    killSwitch: false,
    rehearsalEmail: null,
    rehearsalPhone: null,
    personaName: null,
    personaCompany: null,
    personaIndustry: null,
    personaCity: null,
    dailyEmailCap: 25,
    dailyCallCap: 10,
    sendWindowStartHour: 8,
    sendWindowEndHour: 19,
    timezone: 'America/Chicago',
    postalAddress: null,
    unsubscribeEmail: null,
    emailsSentToday: 0,
    callsPlacedToday: 0,
  };
}

export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  const right = (b ?? '').trim().toLowerCase();
  return left.length > 0 && left === right;
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const digits = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');
  const left = digits(a);
  const right = digits(b);
  if (left.length < 10 || right.length < 10) return false;
  return left.slice(-10) === right.slice(-10);
}

export function isWithinSendWindow(now: Date, policy: OutboundPolicySnapshot): boolean {
  const { sendWindowStartHour: start, sendWindowEndHour: end, timezone } = policy;
  if (start === end) return true;
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Chicago',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now));
  } catch {
    return false;
  }
  if (!Number.isFinite(hour)) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function decideSalesOutbound(input: SalesOutboundInput): SalesOutboundDecision {
  const now = input.now ?? new Date();
  const deny = (reason: string): SalesOutboundDecision => ({ autoApprove: false, rehearsal: false, reason });

  if (!SALES_OUTBOUND_TOOLS.has(input.toolName)) {
    return deny(`${input.toolName} is not a sales outbound tool`);
  }
  const policy = input.policy;
  if (!policy) return deny('outbound policy unavailable; failing closed');
  if (policy.killSwitch) return deny('outbound kill switch is on');
  if (policy.mode === 'off') return deny('outbound policy is off');
  if (input.suppressed) return deny('destination is suppressed');

  const rehearsalEmail = input.toolName !== 'make_outbound_call'
    && sameEmail(input.destinationEmail, policy.rehearsalEmail);
  const rehearsalCall = input.toolName === 'make_outbound_call'
    && samePhone(input.destinationPhone, policy.rehearsalPhone);

  if (rehearsalEmail || rehearsalCall) {
    if (!policy.rehearsalEmail || !policy.rehearsalPhone) {
      return deny('rehearsal profile is incomplete');
    }
    return {
      autoApprove: true,
      rehearsal: true,
      reason: 'destination matches the operator rehearsal profile',
    };
  }

  if (policy.mode !== 'capped_live') {
    return deny('destination is not the rehearsal profile');
  }
  if (!policy.postalAddress?.trim()) {
    return deny('live outreach requires a postal address on the outbound policy');
  }
  if (!isWithinSendWindow(now, policy)) {
    return deny('outside the live send window');
  }

  if (input.toolName === 'send_email_campaign_batch') {
    if (policy.emailsSentToday >= policy.dailyEmailCap) return deny('daily email cap reached');
    return { autoApprove: true, rehearsal: false, reason: 'capped live policy allows the next email batch' };
  }

  if (!input.leadId || !input.leadExists) {
    return deny('live outreach requires a researched lead id');
  }

  if (input.toolName === 'send_email') {
    if (!input.destinationEmail) return deny('missing email destination');
    if (policy.emailsSentToday >= policy.dailyEmailCap) return deny('daily email cap reached');
    return { autoApprove: true, rehearsal: false, reason: 'capped live policy allows this email' };
  }

  if (input.toolName === 'make_outbound_call') {
    if (!input.destinationPhone) return deny('missing phone destination');
    if (policy.callsPlacedToday >= policy.dailyCallCap) return deny('daily call cap reached');
    return { autoApprove: true, rehearsal: false, reason: 'capped live policy allows this call' };
  }

  return deny('unhandled sales tool');
}

export function appendComplianceFooter(
  html: string,
  text: string,
  postalAddress: string,
  unsubscribeEmail: string | null,
): { html: string; text: string } {
  const address = postalAddress.trim();
  const unsub = (unsubscribeEmail ?? '').trim();
  const unsubHtml = unsub
    ? `<br/><a href="mailto:${unsub}?subject=Unsubscribe">Unsubscribe</a>`
    : '';
  const unsubText = unsub ? `\nUnsubscribe: ${unsub}` : '';
  return {
    html: `${html}\n<p style="font-size:12px;color:#666">BuildMyBot<br/>${address}${unsubHtml}</p>`,
    text: `${text}\n\nBuildMyBot\n${address}${unsubText}`,
  };
}

export function isFromDomainError(error: string | undefined): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  return /not verified|invalid `from`|invalid from address|sender domain|domain is not|from domain/.test(text);
}

export function unresolvedMergeTokens(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
}
