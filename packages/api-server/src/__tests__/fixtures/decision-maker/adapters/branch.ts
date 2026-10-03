/**
 * Branch adapter: runs a fixture lead through the same sequence as
 * assessVerifiedLead() on feat/decision-maker-ladder — website identity
 * verification (industry classifier), the decision-maker ladder with the
 * verification bar, contact validation, location check — then asks the shared
 * readiness module which data set the lead lands in. The Postgres research
 * store is swapped for the in-memory one, so nothing touches a database.
 */
import { verifyBusinessWebsiteIdentity, normalizeLeadDomain, makeResearchCacheKey } from '../../../../../../background-jobs/src/lead-pipeline.js';
import {
  InMemoryDomainResearchStore,
  defaultRolesForIndustry,
  runDecisionMakerLadder,
  type FetchResult,
} from '../../../../../../background-jobs/src/decision-maker-ladder.js';
import { validateLeadContacts, normalizePhoneE164 } from '../../../../../../background-jobs/src/lead-quality/contact-validation.js';
import { deriveLeadLocation } from '../../../../../../background-jobs/src/lead-quality/industry.js';
import { classifyTitle } from '../../../../../../background-jobs/src/lead-quality/title-authority.js';
import { cacheReuseAllowed, replaceCompanyNameText } from '../../../../../../background-jobs/src/lead-quality/cache-reuse.js';
import { leadDataSet } from '../../../../lead-readiness.js';
import type { LeadCase } from '../cases.js';
import { fixturePage, withFixtureFetch } from './server.js';
import { SUITE_NOW, type Impl, type LeadDecision } from './types.js';

const okResolver = {
  resolveMx: async () => [{ exchange: 'mx.fixture.test', priority: 10 }],
  resolve4: async () => ['192.0.2.1'],
};

async function evaluateLead(c: LeadCase): Promise<LeadDecision> {
  return withFixtureFetch(c, async () => {
    const identity = await verifyBusinessWebsiteIdentity({ website: c.lead.website, industry: c.lead.industry, city: c.lead.city, currentName: c.lead.companyName });
    if (identity.status !== 'verified') return { contactReady: false, decisionMaker: null, stage: `identity:${identity.status}:${identity.reason}` };
    const domain = normalizeLeadDomain(identity.homepage ?? c.lead.website)!;
    const fetchPage = async (url: string): Promise<FetchResult> => {
      const body = fixturePage(c, url);
      return body == null ? { kind: 'http_error', url, status: 404 } : { kind: 'ok', url, status: 200, html: body };
    };
    const { search } = await runDecisionMakerLadder(
      {
        companyName: c.lead.companyName,
        website: identity.homepage ?? c.lead.website,
        industry: c.lead.industry,
        city: c.lead.city,
        cacheKey: makeResearchCacheKey(c.lead),
        domain,
        structuredScrape: { name: identity.decisionMakerName, title: identity.decisionMakerTitle, sourceUrl: identity.decisionMakerSourceUrl },
      },
      defaultRolesForIndustry(c.lead.industry),
      new InMemoryDomainResearchStore(),
      {
        fetchPage,
        searchProviders: [{ id: 'fixture', configured: () => true, search: async () => c.search ?? [] }],
        now: () => SUITE_NOW,
        maxFetchesPerRun: 40,
      },
    );
    const location = deriveLeadLocation({ leadCity: c.lead.city, siteAddress: identity.siteAddress ?? null });
    const contactValidation = await validateLeadContacts({
      email: c.lead.email ?? identity.contactEmail, phone: c.lead.phone ?? identity.contactPhone, city: location.city ?? c.lead.city, checkMx: true, resolver: okResolver,
    });
    const lead = {
      status: 'new',
      contactEmail: c.lead.email ?? identity.contactEmail,
      contactPhone: c.lead.phone ?? identity.contactPhone,
      enrichment: { businessVerification: { status: 'verified' }, contactValidation, decisionMakerSearch: search, locationCheck: location } as Record<string, unknown>,
    };
    const set = leadDataSet(lead);
    const o = search.outcome;
    return {
      contactReady: set === 'contact_ready',
      decisionMaker: o.status === 'found' ? { name: o.name, title: o.title, sourceUrl: o.sourceUrl } : null,
      stage: `set:${set ?? 'none'};dm:${o.status};${'reason' in o ? o.reason : ''}`,
    };
  });
}

export const branchImpl: Impl = {
  name: 'branch',
  evaluateLead,
  titleQualifies: (title) => classifyTitle(title).qualifies,
  replaceCompanyNameText: (v, a, b) => String(replaceCompanyNameText(v, a, b)),
  phoneFlaggedFake: (phone) => {
    const r = normalizePhoneE164(phone);
    return r.status === 'sentinel' || r.status === 'invalid_nanp';
  },
  cacheRowReadyForNewCity: (row, inputCity, now) => cacheReuseAllowed({
    cachedCity: row.city,
    cachedHasCampaignDraft: Boolean(row.campaignDraft),
    cachedHasContact: Boolean(row.contactResearch.contactEmail || row.contactResearch.contactPhone),
    cachedVerification: row.verification,
    inputCity,
    now,
    env: {},
  }),
};
