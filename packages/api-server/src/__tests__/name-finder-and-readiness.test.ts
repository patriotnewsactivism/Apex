/**
 * Two data sets (contact-ready vs needs-name), the name-finder queue gating,
 * the configurable title policy, contact validators and the ladder's
 * exhaustion/cache rules. Pure modules only: no database, no network.
 */
import { describe, expect, it } from 'vitest';
import { emptyOutboundPolicy, type OutboundPolicySnapshot } from '@workspace/core';
import { computeReadinessStats, leadDataSet, isVerifiedFoundOutcome, type ReadinessLead } from '../lead-readiness.js';
import {
  applyResearchResult,
  approveAction,
  evaluateGate,
  executeApprovedAction,
  newNameFinderState,
  promoteFoundName,
  queueGatedActions,
  readNameFinderState,
  type NameFinderLead,
} from '../../../background-jobs/src/name-finder.js';
import { classifyTitle, loadTitlePolicy } from '../../../background-jobs/src/lead-quality/title-authority.js';
import { selectForRole, verifyCandidate, sourcePageKind, extractPeopleFromPage, type PersonRecord } from '../../../background-jobs/src/lead-quality/people.js';
import { normalizePhoneE164, checkEmailFormat, cleanEmailCandidate, validateEmail, clearMxCache } from '../../../background-jobs/src/lead-quality/contact-validation.js';
import { publicContactsFromHtml } from '../../../background-jobs/src/lead-quality/extract-contacts.js';
import { registrableDomain } from '../../../background-jobs/src/lead-quality/domain.js';
import { exhaustionOutcome, runDecisionMakerLadderForRole, emptyDomainResearch, LADDER_STEPS, type StepAttempt, type DecisionMakerSearch } from '../../../background-jobs/src/decision-maker-ladder.js';

const NOW = new Date('2026-10-03T20:00:00.000Z');
const killSwitchOn: OutboundPolicySnapshot = { ...emptyOutboundPolicy(), mode: 'capped_live', killSwitch: true, postalAddress: '1 Main St' };

function baseLead(enrichment: Record<string, unknown> = {}): ReadinessLead & NameFinderLead {
  return {
    id: 'lead-1', companyName: 'Acme Roofing', industry: 'roofing', city: 'Denver, CO', status: 'new',
    contactEmail: 'info@acmeroofing.com', contactPhone: '+13032964410',
    enrichment: { businessVerification: { status: 'verified' }, contactValidation: { validated: true }, ...enrichment },
  };
}
const cantLocate = { decisionMakerSearch: { outcome: { status: 'cant_locate', reason: 'no_role_match_after_ladder', fullLadder: true, skippedForConfig: [] } } };
const found = (extra: Record<string, unknown> = {}) => ({ decisionMakerSearch: { outcome: { status: 'found', name: 'Jane Roe', title: 'Owner', sourceUrl: 'https://acmeroofing.com/about', verifiedBy: 'first_party', ...extra } } });

describe('two data sets', () => {
  it('named verified decision maker → contact_ready; cant_locate → needs_name; flag default keeps them apart', () => {
    expect(leadDataSet(baseLead(found()))).toBe('contact_ready');
    expect(leadDataSet(baseLead(cantLocate))).toBe('needs_name');
    const stats = computeReadinessStats([baseLead(found()), baseLead(cantLocate), baseLead(cantLocate)], { cantLocateCountsReady: false });
    expect(stats.contactReady).toBe(1);
    expect(stats.needsName).toBe(2);
  });
  it('a found outcome without sourceUrl or verifiedBy is NOT contact-ready (stays needs_name)', () => {
    expect(isVerifiedFoundOutcome({ status: 'found', name: 'Jane Roe', title: 'Owner', sourceUrl: '' , verifiedBy: 'first_party' })).toBe(false);
    expect(leadDataSet(baseLead(found({ verifiedBy: undefined })))).toBe('needs_name');
    expect(leadDataSet(baseLead(found({ sourceUrl: undefined })))).toBe('needs_name');
  });
  it('geo mismatch keeps a lead out of both sets', () => {
    expect(leadDataSet(baseLead({ ...found(), locationCheck: { geoMismatch: true } }))).toBeNull();
  });
});

describe('name-finder queue', () => {
  it('queues email + call as awaiting_approval with the kill-switch gate recorded; nothing is sent', () => {
    const state = queueGatedActions(newNameFinderState(NOW), baseLead(cantLocate), killSwitchOn, NOW);
    expect(state.status).toBe('awaiting_approval');
    expect(state.actions.map((a) => [a.step, a.status])).toEqual([['email', 'awaiting_approval'], ['call', 'awaiting_approval']]);
    for (const a of state.actions) {
      expect(a.gateAtQueue?.blocked).toBe(true);
      expect(a.gateAtQueue?.reason).toContain('kill switch');
    }
    expect(state.actions[0]!.email?.body).toMatch(/who is the right person/i);
  });
  it('approval requires a named approver and, with the kill switch ON, ends blocked_by_gate', () => {
    const lead = baseLead(cantLocate);
    const state = queueGatedActions(newNameFinderState(NOW), lead, killSwitchOn, NOW);
    const email = state.actions[0]!;
    expect(approveAction(state, email.id, '  ', evaluateGate(email, lead, killSwitchOn, { now: NOW }), NOW).error).toBe('approver_required');
    const r = approveAction(state, email.id, 'matthew', evaluateGate(email, lead, killSwitchOn, { now: NOW }), NOW);
    expect(r.action?.status).toBe('blocked_by_gate');
    expect(r.action?.approvedBy).toBe('matthew');
  });
  it('even approved + gate-allowed, execution refuses without APEX_NAME_FINDER_OUTBOUND_ENABLED and re-checks the gate', async () => {
    const lead = baseLead(cantLocate);
    const state = queueGatedActions(newNameFinderState(NOW), lead, killSwitchOn, NOW);
    const allow = { autoApprove: true, rehearsal: false, reason: 'test allow' };
    const approved = approveAction(state, state.actions[0]!.id, 'matthew', allow, NOW).action!;
    expect(approved.status).toBe('ready_to_execute');
    let sends = 0;
    const senders = { sendEmail: async () => { sends++; return {}; } };
    const off = await executeApprovedAction(approved, lead, allow, senders, NOW, {});
    expect(off.note).toBe('outbound_disabled_by_flag');
    const killed = await executeApprovedAction(approved, lead, { autoApprove: false, rehearsal: false, reason: 'outbound kill switch is on' }, senders, NOW, { APEX_NAME_FINDER_OUTBOUND_ENABLED: 'true' });
    expect(killed.status).toBe('blocked_by_gate');
    expect(sends).toBe(0);
  });
  it('a qualifying name from a call moves the lead to contact_ready immediately with the source recorded; open asks are cancelled', () => {
    const lead = baseLead(cantLocate);
    lead.enrichment = { ...lead.enrichment, nameFinder: queueGatedActions(newNameFinderState(NOW), lead, killSwitchOn, NOW) };
    const r = promoteFoundName(lead, { name: 'Maria Lopez', title: 'Vice President of Operations', source: 'phone_call', sourceUrl: 'call:abc123' }, NOW);
    expect(r.promoted).toBe(true);
    const after = { ...lead, enrichment: r.enrichment };
    expect(leadDataSet(after)).toBe('contact_ready');
    expect((r.enrichment['decisionMakerSearch'] as DecisionMakerSearch).outcome).toMatchObject({ status: 'found', source: 'phone_call', verifiedBy: 'company_direct' });
    expect(readNameFinderState(after)?.actions.every((a) => a.status === 'cancelled')).toBe(true);
  });
  it('a below-bar name (receptionist) stays in needs_name with the candidate recorded', () => {
    const lead = baseLead(cantLocate);
    const r = promoteFoundName(lead, { name: 'Amy Hart', title: 'Receptionist', source: 'email_reply', sourceUrl: 'email-reply:msg-1' }, NOW);
    expect(r.promoted).toBe(false);
    expect(leadDataSet({ ...lead, enrichment: r.enrichment })).toBe('needs_name');
    expect(readNameFinderState({ enrichment: r.enrichment })?.candidate).toMatchObject({ name: 'Amy Hart' });
  });
  it('automatic research that finds nobody records the run and queues the gated asks', () => {
    const search = { ladderVersion: 'x', outcome: { status: 'cant_locate', reason: 'r', fullLadder: true, skippedForConfig: [], candidate: null }, reason: 'r', exhaustedAt: NOW.toISOString(), stepsTried: [], primaryRole: 'owner_executive', roles: {} } as unknown as DecisionMakerSearch;
    const r = applyResearchResult(baseLead(cantLocate), search, killSwitchOn, NOW);
    const state = readNameFinderState({ enrichment: r.enrichment })!;
    expect(state.researchRuns).toHaveLength(1);
    expect(state.actions.filter((a) => a.status === 'awaiting_approval')).toHaveLength(2);
  });
});

describe('title policy: tiers, conditional, configurable', () => {
  it('assigns authority tiers', () => {
    expect(classifyTitle('Owner').tier).toBe(1);
    expect(classifyTitle('VP of Sales').tier).toBe(2);
    expect(classifyTitle('Director of Marketing').tier).toBe(3);
  });
  it('office manager counts only when no one more senior is verified', () => {
    const p = (name: string, title: string): PersonRecord => ({ name, title, sourceUrl: 'https://acmeroofing.com/team', method: 'team_page_text', methodConfidence: 0.75, seenAt: NOW.toISOString() });
    const ctx = { companyName: 'Acme Roofing', domain: 'acmeroofing.com', now: NOW };
    expect(selectForRole([p('Amy Hart', 'Office Manager')], 'owner_executive', ctx)?.person.name).toBe('Amy Hart');
    expect(selectForRole([p('Amy Hart', 'Office Manager'), p('Ben Cole', 'Director of Operations')], 'owner_executive', ctx)?.person.name).toBe('Ben Cole');
  });
  it('env allow/deny lists and min tier', () => {
    const policy = loadTitlePolicy({ APEX_DM_TITLE_ALLOW_EXTRA: 'chief of staff:2', APEX_DM_TITLE_DENY_EXTRA: 'creative director', APEX_DM_MIN_TIER: '2' });
    expect(classifyTitle('Chief of Staff', policy)).toMatchObject({ qualifies: true, tier: 2 });
    expect(classifyTitle('Creative Director', policy).qualifies).toBe(false);
    expect(classifyTitle('Director of Operations', policy).qualifies).toBe(false); // tier 3 > min 2
  });
});

describe('verification bar (dry-run errors)', () => {
  const ctx = (domain: string, companyName: string) => ({ domain, companyName, now: NOW });
  it('NHBR: event-page quote of another org\'s CEO is rejected', () => {
    const v = verifyCandidate({ name: 'Beth Slepian', title: 'President & CEO, Granite VNA', sourceUrl: 'https://www.nhbr.com/events-awards/leadership-unscripted-event/', method: 'json_ld_person', methodConfidence: 0.9, seenAt: NOW.toISOString() }, [], ctx('nhbr.com', 'NH Business Review'));
    expect(v.verified).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(['affiliation_other_org', 'source_article_or_search_page']));
    expect(sourcePageKind('https://www.nhbr.com/events-awards/leadership-unscripted-event/')).toBe('article');
  });
  it('KXLB: sister-site associate editor is rejected', () => {
    const v = verifyCandidate({ name: 'Carena Liptak', title: 'Associate Editor', sourceUrl: 'https://tasteofcountry.com/author/carena-liptak/', method: 'web_search', methodConfidence: 0.55, seenAt: NOW.toISOString() }, [], ctx('xlcountry.com', '100.7 KXLB'));
    expect(v.verified).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(['title_denied:assistant', 'source_off_domain_uncorroborated']));
  });
  it('KCUR: "Luke X. Martin Culture" is not extracted as a person', () => {
    const people = extractPeopleFromPage('<ul><li>Luke X. Martin Culture — Editor</li></ul>', 'https://www.kcur.org/staff', 'team', NOW.toISOString(), { domain: 'kcur.org' });
    expect(people.map((p) => p.name)).not.toContain('Luke X. Martin Culture');
  });
  it('stale people (>365 days) do not count', () => {
    const v = verifyCandidate({ name: 'Robert King', title: 'Owner', sourceUrl: 'https://acme.com/about', method: 'json_ld_person', methodConfidence: 0.9, seenAt: '2024-01-01T00:00:00Z' }, [], ctx('acme.com', 'Acme'));
    expect(v.reasons).toContain('stale');
  });
});

describe('contacts', () => {
  it('phones: sentinels flagged, vanity toll-free kept, E.164 string', () => {
    expect(normalizePhoneE164('+12147483647').status).toBe('sentinel');
    expect(normalizePhoneE164('+19444444444').status).toBe('sentinel');
    expect(normalizePhoneE164('888-880-8888')).toMatchObject({ status: 'valid', e164: '+18888808888' });
    expect(normalizePhoneE164('(011) 555-1234').status).not.toBe('valid');
  });
  it('emails: asset filenames, masked and malito:%20 junk', () => {
    expect(checkEmailFormat('site-nav-logo@2x.png').status).not.toBe('valid');
    expect(checkEmailFormat('in**@****47.com').status).not.toBe('valid');
    expect(cleanEmailCandidate('malito:%20info@acme.com')).toBe('info@acme.com');
  });
  it('MX lookup uses the resolver and caches', async () => {
    clearMxCache();
    let calls = 0;
    const resolver = { resolveMx: async () => { calls++; return [{ exchange: 'mx.acme.com', priority: 1 }]; }, resolve4: async () => [] };
    await validateEmail('a@acme-mx-test.com', { resolver });
    await validateEmail('b@acme-mx-test.com', { resolver });
    expect(calls).toBe(1);
  });
  it('contacts inside <script>/<style> are ignored', () => {
    const c = publicContactsFromHtml('<html><head><script>var p="(303) 296-4410"; var e="owner@acme.com";</script><style>/* (720) 555-0100 */</style></head><body><p>Hello</p></body></html>');
    expect(c.phone).toBeNull();
    expect(c.email).toBeNull();
  });
  it('registrable domain', () => {
    expect(registrableDomain('https://edition.cnn.com/us')).toBe('cnn.com');
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
  });
});

describe('ladder exhaustion and cross-role cache reuse', () => {
  const step = (s: StepAttempt['step'], status: StepAttempt['status']): StepAttempt => ({ step: s, status, ranAt: NOW.toISOString(), scope: 'role_agnostic', fromCache: false });
  it('any transient step → pending_retry; all ran → cant_locate; config skips recorded', () => {
    expect(exhaustionOutcome(LADDER_STEPS.map((s) => step(s, s === 'web_search' ? 'error_transient' : 'no_result'))).status).toBe('pending_retry');
    const done = exhaustionOutcome(LADDER_STEPS.map((s) => step(s, s === 'hunter_domain_search' ? 'skipped_missing_config' : 'no_result')));
    expect(done).toMatchObject({ status: 'cant_locate', fullLadder: false, skippedForConfig: ['hunter_domain_search'] });
  });
  it('a second role reuses the domain cache: zero new fetches for role-agnostic steps', async () => {
    let fetches = 0;
    const deps = {
      fetchPage: async (url: string) => { fetches++; return { kind: 'ok' as const, url, status: 200, html: '<html><body><p>Acme Roofing</p></body></html>' }; },
      searchProviders: [], now: () => NOW, maxFetchesPerRun: 40,
    };
    const lead = { companyName: 'Acme Roofing', website: 'https://acmeroofing.com/', industry: 'roofing', city: 'Denver, CO', cacheKey: 'domain:acmeroofing.com', domain: 'acmeroofing.com' };
    const research = emptyDomainResearch('acmeroofing.com', NOW);
    await runDecisionMakerLadderForRole(lead, 'owner_executive', research, deps);
    const first = fetches;
    const second = await runDecisionMakerLadderForRole(lead, 'marketing', research, deps);
    const roleAgnosticFresh = second.stepsTried.filter((s) => s.scope === 'role_agnostic' && !s.fromCache && s.status !== 'skipped_missing_config' && s.status !== 'not_applicable');
    expect(first).toBeGreaterThan(0);
    expect(roleAgnosticFresh).toEqual([]);
    // Only the new role's own site_search pages were fetched.
    expect(fetches - first).toBe(2);
  });
});
