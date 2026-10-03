/**
 * Decision-maker title policy (Matthew, 2026-10-03 3:39 PM CT).
 *
 * A decision maker is anyone with real decision-making authority and a direct
 * line to the owner — not only the owner. Titles are sorted into authority
 * tiers; a denylist removes generic staff regardless of tier. Both lists are
 * configurable through env without a code change:
 *
 *   APEX_DM_TITLE_ALLOW_EXTRA  "chief of staff:2,head coach:3"   (phrase[:tier], tier default 3)
 *   APEX_DM_TITLE_DENY_EXTRA   "ambassador,brand partner"        (phrase)
 *   APEX_DM_MIN_TIER           highest tier number that qualifies (default 3)
 *
 * Tier 1  ownership / top executive   owner, founder, CEO, president, publisher, managing partner, principal, executive director
 * Tier 2  senior authority            GM, COO, CFO, CMO, CRO, chief * officer, partner, VP / vice president *, editor-in-chief,
 *                                     executive editor, managing editor, news director, station manager, operations manager (station)
 * Tier 3  department head             director *, head of *, program director, practice / general / office manager*
 *         *office manager is conditional: it only qualifies when it is the most senior title the company publishes.
 */

export type AuthorityTier = 1 | 2 | 3;

export interface TitleRule {
  id: string;
  pattern: RegExp;
  tier: AuthorityTier;
  /** Qualifies only when no higher-tier verified person exists for the company. */
  conditional?: boolean;
}

export interface DenyRule { id: string; pattern: RegExp }

export interface TitlePolicy {
  allow: TitleRule[];
  deny: DenyRule[];
  minTier: AuthorityTier;
}

export const DEFAULT_ALLOW_RULES: TitleRule[] = [
  { id: 'owner', pattern: /\b(?:co-?)?owners?\b|\bproprietor\b/i, tier: 1 },
  { id: 'founder', pattern: /\b(?:co-?)?founders?\b/i, tier: 1 },
  { id: 'ceo', pattern: /\bceo\b|\bchief executive\b/i, tier: 1 },
  { id: 'president', pattern: /^(?!.*\bvice\b)(?!.*\bpresident of (?:the )?(?:board|association|chamber|club)\b).*\bpresident\b/i, tier: 1 },
  { id: 'publisher', pattern: /^(?!.*\b(?:associate|assistant)\b).*\bpublisher\b/i, tier: 1 },
  { id: 'managing_partner', pattern: /\bmanaging (?:partner|member)\b|\bprincipal\b(?! (?:engineer|designer|scientist|consultant))/i, tier: 1 },
  { id: 'executive_director', pattern: /\bexecutive director\b/i, tier: 1 },
  { id: 'chief_officer', pattern: /\b(?:coo|cfo|cmo|cro|cto|chief [a-z]+ officer)\b|\bchief (?:operating|financial|marketing|revenue|technology|content)\b/i, tier: 2 },
  { id: 'general_manager', pattern: /\bgeneral manager\b|\bgm\b|\bmanaging director\b/i, tier: 2 },
  { id: 'partner', pattern: /^(?!.*\b(?:associate|junior|paralegal|brand|channel|community)\b).*\bpartner\b/i, tier: 2 },
  { id: 'vice_president', pattern: /\b(?:s?vp|evp|vice[- ]president)\b/i, tier: 2 },
  { id: 'editor_in_chief', pattern: /\beditor[- ]in[- ]chief\b|\bexecutive editor\b|\bmanaging editor\b|\beditorial director\b/i, tier: 2 },
  { id: 'news_director', pattern: /\bnews director\b|\bdirector of news\b/i, tier: 2 },
  { id: 'station_manager', pattern: /\bstation manager\b|\bmarket manager\b|\boperations manager\b/i, tier: 2 },
  { id: 'director', pattern: /\bdirector\b/i, tier: 3 },
  { id: 'head_of', pattern: /\bhead of\b|\b(?:department|division) head\b/i, tier: 3 },
  { id: 'program_director', pattern: /\bprogram(?:ming)? director\b/i, tier: 3 },
  { id: 'practice_manager', pattern: /\bpractice manager\b|\bbusiness manager\b/i, tier: 3 },
  { id: 'office_manager', pattern: /\boffice manager\b/i, tier: 3, conditional: true },
];

export const DEFAULT_DENY_RULES: DenyRule[] = [
  { id: 'former', pattern: /\b(?:former(?:ly)?|ex-|retired|emerit(?:us|a)|past|late)\b/i },
  { id: 'assistant', pattern: /\bassistant\b|\bassoc\.?\b|\bassociate\b|\bdeputy\b|\bto the\b/i },
  { id: 'junior_staff', pattern: /\b(?:coordinator|intern|internship|trainee|apprentice|fellow|volunteer|receptionist|clerk|secretary|technician|specialist|representative|rep|agent|staff)\b/i },
  { id: 'newsroom_staff', pattern: /\b(?:reporter|writer|contributor|contributing|correspondent|columnist|blogger|freelance(?:r)?|stringer|photographer|photojournalist|videographer|anchor|meteorologist|host|producer|dj|personality|on-air|copy ?editor|designer)\b/i },
  { id: 'sales_staff', pattern: /\b(?:sales (?:rep|representative|associate|consultant|executive)|account (?:executive|manager|rep)|media consultant|advertising consultant|marketing consultant|business development (?:rep|representative|associate))\b/i },
  { id: 'board_only', pattern: /\bboard (?:member|of directors)\b|\btrustee\b|\badvisory\b/i },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRegex(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRegex(phrase.trim())}\\b`, 'i');
}

export function loadTitlePolicy(env: NodeJS.ProcessEnv = process.env): TitlePolicy {
  const allow = [...DEFAULT_ALLOW_RULES];
  const deny = [...DEFAULT_DENY_RULES];
  for (const raw of (env.APEX_DM_TITLE_ALLOW_EXTRA ?? '').split(',')) {
    const [phrase, tierRaw] = raw.split(':');
    if (!phrase?.trim()) continue;
    const tier = Number(tierRaw);
    allow.unshift({ id: `env_allow:${phrase.trim().toLowerCase()}`, pattern: phraseRegex(phrase), tier: tier === 1 || tier === 2 ? tier : 3 });
  }
  for (const phrase of (env.APEX_DM_TITLE_DENY_EXTRA ?? '').split(',')) {
    if (phrase.trim()) deny.push({ id: `env_deny:${phrase.trim().toLowerCase()}`, pattern: phraseRegex(phrase) });
  }
  const min = Number(env.APEX_DM_MIN_TIER);
  return { allow, deny, minTier: min === 1 || min === 2 ? min : 3 };
}

export interface TitleClassification {
  qualifies: boolean;
  tier: AuthorityTier | null;
  conditional: boolean;
  matched: string | null;
  deniedBy: string | null;
}

/**
 * Classify a title. Strict: any deny hit rejects, even when an allow rule also
 * matches ("Associate Publisher", "Former CEO", "Producer and Owner"). The one
 * exception is an explicit APEX_DM_TITLE_ALLOW_EXTRA phrase, which is operator
 * config and wins over the default denylist ("chief of staff:2").
 */
export function classifyTitle(title: string | null | undefined, policy: TitlePolicy = loadTitlePolicy()): TitleClassification {
  const t = (title ?? '').trim();
  const none: TitleClassification = { qualifies: false, tier: null, conditional: false, matched: null, deniedBy: null };
  if (!t || t.length > 90) return none;
  const deniedBy = policy.deny.find((rule) => rule.pattern.test(t))?.id ?? null;
  let best: TitleRule | null = null;
  for (const rule of policy.allow) {
    if (rule.pattern.test(t) && (!best || rule.tier < best.tier)) best = rule;
  }
  const operatorAllowed = policy.allow.some((rule) => rule.id.startsWith('env_allow:') && rule.pattern.test(t));
  if (deniedBy && !operatorAllowed) return { ...none, tier: best?.tier ?? null, matched: best?.id ?? null, deniedBy };
  if (!best) return none;
  return {
    qualifies: best.tier <= policy.minTier,
    tier: best.tier,
    conditional: Boolean(best.conditional),
    matched: best.id,
    deniedBy: null,
  };
}
