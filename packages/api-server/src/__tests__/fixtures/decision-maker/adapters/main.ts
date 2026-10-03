/**
 * origin/main adapter. Runs the fixtures through main's real exported
 * verifyBusinessWebsiteIdentity() from a separate, unmodified worktree
 * (DM_SUITE_MAIN_ROOT, default /workspace/apex-llm/baseline-wt) and applies
 * main's contact-ready gate from routes/leads.ts (/stats): not rejected AND
 * (email OR phone) AND businessVerification verified — main has no
 * decision-maker requirement.
 *
 * Three rules are private (non-exported) on main, so they are copied
 * verbatim below; `assertCopiedFromMain()` checks each copy still appears
 * character-for-character in main's source so the adapter cannot drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeadCase } from '../cases.js';
import { withFixtureFetch } from './server.js';
import type { Impl, LeadDecision } from './types.js';

export const MAIN_ROOT = process.env.DM_SUITE_MAIN_ROOT ?? '/workspace/apex-llm/baseline-wt';
const MAIN_PIPELINE = join(MAIN_ROOT, 'packages/background-jobs/src/lead-pipeline.ts');

// main lead-pipeline.ts structuredDecisionMakerFromHtml (seniority regex), verbatim:
const MAIN_SENIORITY_SRC = "const seniority = /\\b(owner|founder|co-founder|president|ceo|chief executive|managing partner|managing member|principal|partner)\\b/i;";
const seniority = /\b(owner|founder|co-founder|president|ceo|chief executive|managing partner|managing member|principal|partner)\b/i;

// main lead-pipeline.ts:1062-1065 replaceCompanyNameText, verbatim body:
const MAIN_REPLACE_SRC = 'return value.split(oldName).join(newName);';
function mainReplaceCompanyNameText(value: string | null | undefined, oldName: string, newName: string): string | null | undefined {
  if (!value || oldName === newName) return value;
  return value.split(oldName).join(newName);
}

// main lead-pipeline.ts insertDiscoveredLead readyFromCache, verbatim:
const MAIN_READY_SRC = "cachedVerification?.status === 'verified',\n  );";

export function assertCopiedFromMain(): void {
  const src = readFileSync(MAIN_PIPELINE, 'utf8');
  for (const [label, needle] of [['seniority', MAIN_SENIORITY_SRC], ['replaceCompanyNameText', MAIN_REPLACE_SRC], ['readyFromCache', MAIN_READY_SRC]] as const) {
    if (!src.includes(needle)) throw new Error(`main adapter drift: ${label} not found verbatim in ${MAIN_PIPELINE}`);
  }
  if (/readyFromCache[\s\S]{0,400}sameCity/.test(src)) throw new Error('main adapter drift: main already has a same-city cache rule');
}

type MainPipeline = { verifyBusinessWebsiteIdentity: (input: { website?: string | null; industry?: string | null; city?: string | null; currentName?: string | null }) => Promise<{ status: string; reason: string; contactEmail: string | null; contactPhone: string | null; decisionMakerName: string | null; decisionMakerTitle: string | null; decisionMakerSourceUrl: string | null }> };
let loaded: Promise<MainPipeline> | null = null;
const mainPipeline = () => (loaded ??= import(/* @vite-ignore */ MAIN_PIPELINE) as Promise<MainPipeline>);

async function evaluateLead(c: LeadCase): Promise<LeadDecision> {
  const { verifyBusinessWebsiteIdentity } = await mainPipeline();
  return withFixtureFetch(c, async () => {
    const identity = await verifyBusinessWebsiteIdentity({ website: c.lead.website, industry: c.lead.industry, city: c.lead.city, currentName: c.lead.companyName });
    const email = c.lead.email ?? identity.contactEmail;
    const phone = c.lead.phone ?? identity.contactPhone;
    const contactReady = identity.status === 'verified' && Boolean(email || phone);
    return {
      contactReady,
      decisionMaker: identity.decisionMakerName ? { name: identity.decisionMakerName, title: identity.decisionMakerTitle, sourceUrl: identity.decisionMakerSourceUrl } : null,
      stage: `identity:${identity.status}:${identity.reason}`,
    };
  });
}

export const mainImpl: Impl = {
  name: 'main',
  evaluateLead,
  // main: a decision maker only counts with an owner/founder/president/CEO/partner title.
  titleQualifies: (title) => seniority.test(title),
  replaceCompanyNameText: (v, a, b) => String(mainReplaceCompanyNameText(v, a, b)),
  // main has no fake-number check: normalizeUsBusinessPhone keeps any 10/11-digit number.
  phoneFlaggedFake: (phone) => {
    const digits = phone.replace(/\D/g, '');
    return !(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')));
  },
  // main: cachedCampaignDraft && cachedHasContact && verified — no city or age check.
  cacheRowReadyForNewCity: (row) => Boolean(row.campaignDraft && (row.contactResearch.contactEmail || row.contactResearch.contactPhone) && row.verification.status === 'verified'),
};
