// Designed sales sequences. Agents may personalize an outreach angle, but they
// do not invent the layout. Rehearsal and live enrollment both copy these
// templates so a campaign is the same message every time.

export interface PlaybookEmail {
  subject: string;
  html: string;
  text: string;
}

export interface SalesPlaybook {
  id: string;
  version: number;
  name: string;
  summary: string;
  openEmail: PlaybookEmail;
  followUpEmail: PlaybookEmail;
  call: {
    firstMessage: string;
    assistantPrompt: string;
  };
}

export interface PlaybookFields {
  buyerName?: string | null;
  companyName?: string | null;
  industry?: string | null;
  city?: string | null;
  outreachAngle?: string | null;
  transcriptSnippet?: string | null;
}

const OPTIONAL_FIELDS = new Set(['outreachAngle', 'transcriptSnippet', 'industry', 'city']);

export function emailGreetingName(fullName: string | null | undefined): string {
  const raw = typeof fullName === 'string' ? fullName.trim() : '';
  if (!raw) return 'there';

  const withoutTitle = raw.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '').trim();
  if (!withoutTitle) return 'there';

  // Handle "Last, First" as well as the normal "First Last" form.
  if (withoutTitle.includes(',')) {
    const [, given = ''] = withoutTitle.split(',', 2);
    const first = given.trim().split(/\s+/)[0];
    if (first) return first;
  }

  return withoutTitle.split(/\s+/)[0] || 'there';
}

export const BUILD_MY_BOT_INTRO: SalesPlaybook = {
  id: 'buildmybot-intro',
  version: 7,
  name: 'BuildMyBot intro',
  summary: 'One cold email, one sales call, and one follow-up. The buyer is treated as the owner of a local business that misses calls.',
  openEmail: {
    subject: '{{companyName}} is losing jobs after hours',
    html: [
      '<p>Hi {{buyerName}},</p>',
      '<p>I am reaching out because {{companyName}} looks like the kind of {{industry}} business in {{city}} that still loses work when nobody picks up. BuildMyBot answers those calls and messages, captures the lead, and books the next step while your team is on a job.</p>',
      '<p>{{outreachAngle}}</p>',
      '<p>I am not asking you to buy anything on this email. I want ten minutes to show you what the call sounds like on a real after-hours lead. If it is not useful, I will stop.</p>',
      '<p>Don Matthews<br/>BuildMyBot</p>',
    ].join('\n'),
    text: [
      'Hi {{buyerName}},',
      '',
      'I am reaching out because {{companyName}} looks like the kind of {{industry}} business in {{city}} that still loses work when nobody picks up. BuildMyBot answers those calls and messages, captures the lead, and books the next step while your team is on a job.',
      '',
      '{{outreachAngle}}',
      '',
      'I am not asking you to buy anything on this email. I want ten minutes to show you what the call sounds like on a real after-hours lead. If it is not useful, I will stop.',
      '',
      'Don Matthews',
      'BuildMyBot',
    ].join('\n'),
  },
  followUpEmail: {
    subject: 'After our call about {{companyName}}',
    html: [
      '<p>Hi {{buyerName}},</p>',
      '<p>Following up on the call about missed leads at {{companyName}}. {{transcriptSnippet}}</p>',
      '<p>If you want to hear it against one of your own after-hours calls, reply with a time that works this week. If you do not, no need to reply and I will not keep emailing.</p>',
      '<p>Don Matthews<br/>BuildMyBot</p>',
    ].join('\n'),
    text: [
      'Hi {{buyerName}},',
      '',
      'Following up on the call about missed leads at {{companyName}}. {{transcriptSnippet}}',
      '',
      'If you want to hear it against one of your own after-hours calls, reply with a time that works this week. If you do not, no need to reply and I will not keep emailing.',
      '',
      'Don Matthews',
      'BuildMyBot',
    ].join('\n'),
  },
  call: {
    firstMessage: 'We help businesses like {{companyName}} catch missed calls before they turn into lost jobs. When a call comes in and nobody can answer, what happens to it?',
    assistantPrompt: [
      'You are Don, a BuildMyBot sales rep on a live phone call. The person who answered is {{buyerName}}, the buyer at {{companyName}}, a {{industry}} business in {{city}}.',
      'Goal: have a real conversation and earn a ten-minute follow-up. Do not quote a price. Do not say they can subscribe or pay today. Do not invent product features. BuildMyBot answers calls and messages the business would otherwise miss, captures the lead, and helps book the next step.',
      'Sound like a person, not a script. Speak English only. After identity is confirmed, acknowledge them by first name once, ask how their day is going, and give their answer a brief empathetic response before moving into the reason for the call. Ask one question at a time. Use complete sentences at a relaxed pace. If they are busy, offer to call back and end the call. If they object, acknowledge it briefly and ask what they do with after-hours calls today.',
      'Opening angle, if you have one: {{outreachAngle}}',
      'Never claim you already sent a checkout link. Never claim a feature you were not told about in this prompt.',
    ].join('\n'),
  },
};

const PLAYBOOKS = [BUILD_MY_BOT_INTRO];

export function listSalesPlaybooks(): SalesPlaybook[] {
  return PLAYBOOKS;
}

export function getSalesPlaybook(id: string): SalesPlaybook | null {
  return PLAYBOOKS.find((playbook) => playbook.id === id) ?? null;
}

/** Replace {{field}} tokens. Optional fields with no value are removed.
 *  Any other leftover token is reported so the caller can refuse to send. */
export function renderPlaybookTemplate(
  template: string,
  fields: PlaybookFields,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const raw = fields[key as keyof PlaybookFields];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value) return value;
    if (OPTIONAL_FIELDS.has(key)) return '';
    missing.push(key);
    return match;
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), missing };
}

export function rehearsalPersonaFields(input: {
  buyerName: string;
  companyName: string;
  industry: string;
  city: string;
}): PlaybookFields {
  return {
    buyerName: emailGreetingName(input.buyerName),
    companyName: input.companyName.trim(),
    industry: input.industry.trim() || 'local service',
    city: input.city.trim() || 'your area',
    outreachAngle: 'The useful version of this is a missed call turning into a booked job instead of a voicemail nobody hears until morning.',
    transcriptSnippet: 'We talked about what happens to calls that come in when the crew is already on a job.',
  };
}
