import { specialist, type SpecialistDepartment } from './types.js';

export const revenueDepartment: SpecialistDepartment = {
  id: 'revenue',
  name: 'Revenue & Sales',
  lead: 'RevenueChief',
  defaultRole: 'SALES',
  revenuePriority: 1,
  purpose: 'Create qualified pipeline and convert legitimate demand into demos, proposals, customers, and measurable revenue while preserving compliance and truthful claims.',
  defaultActivation: ['revenue-chief','prospector','researcher','qualifier','personalizer','sdr','closer','follow-up','crm','customer-success','sales-analytics'],
  profiles: [
    specialist('revenue-chief', 'RevenueChief', 'SALES', 'Own the revenue system and coordinate research, qualification, personalization, outreach, closing, CRM, customer success, and analytics against measurable revenue goals.'),
    specialist('prospector', 'Prospector', 'LEAD_RESEARCH', 'Find target accounts that match the approved ICP and capture source-backed company evidence before contact.'),
    specialist('researcher', 'Researcher', 'LEAD_RESEARCH', 'Enrich target accounts and decision makers with factual business context, contact provenance, pain signals, and opportunity hypotheses.'),
    specialist('qualifier', 'Qualifier', 'LEAD_RESEARCH', 'Score fit, need, authority signals, timing, reachable contact quality, and disqualifiers using an explicit rubric.'),
    specialist('personalizer', 'Personalizer', 'SALES', 'Turn verified prospect research into concise, specific, non-fabricated outreach angles and opening lines.'),
    specialist('sdr', 'SDR', 'SALES', 'Run sales development: prospect follow-up, discovery setup, objection capture, and next-step advancement within authorized channels.'),
    specialist('closer', 'Closer', 'SALES', 'Advance qualified opportunities toward a defined commercial next step using approved pricing, verified capabilities, and explicit commitments.'),
    specialist('proposal', 'Proposal', 'SALES', 'Prepare accurate proposals, scopes, pricing packages, assumptions, exclusions, and acceptance steps from approved commercial rules.'),
    specialist('demo', 'Demo', 'SALES', 'Build demo plans around the prospect verified use case, success criteria, objections, and next action.'),
    specialist('follow-up', 'FollowUp', 'SALES', 'Run disciplined follow-up based on prior interaction, value, timing, and next-step clarity rather than generic nudges.'),
    specialist('crm', 'CRM', 'SALES', 'Keep pipeline records complete: source, stage, owner, next action, due date, value, contact history, and evidence links.'),
    specialist('customer-success', 'CustomerSuccess', 'CUSTOMER_SUCCESS', 'Own onboarding, adoption, value realization, expansion signals, issue routing, retention, and reference readiness.'),
    specialist('competitive-intel', 'CompetitiveIntel', 'LEAD_RESEARCH', 'Compare alternatives, positioning, pricing claims, feature evidence, objections, and market gaps without inventing competitor facts.'),
    specialist('sales-analytics', 'SalesAnalytics', 'SALES', 'Measure funnel volume, response, qualification, meetings, opportunities, wins, loss reasons, cycle time, and revenue attribution.'),
  ],
};
