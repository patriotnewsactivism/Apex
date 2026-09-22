import { specialist, type SpecialistDepartment } from './types.js';

export const operationsDepartment: SpecialistDepartment = {
  id: 'operations',
  name: 'Business Operations',
  lead: 'COO',
  defaultRole: 'COO',
  revenuePriority: 4,
  purpose: 'Run operating metrics, pricing analysis, procurement, entity and contract workflows, finance visibility, fundraising research, and internal controls.',
  defaultActivation: ['coo-specialist','cfo','ledger','pricing','procurement','contracts','entity-manager','investor-relations','grant-scout','metrics'],
  profiles: [
    specialist('coo-specialist', 'COO', 'COO', 'Coordinate business operations, delivery capacity, cross-department execution, and operating cadence against measurable outcomes.'),
    specialist('cfo', 'CFO', 'COO', 'Model cash flow, unit economics, runway, scenario ranges, and finance controls using clearly labeled assumptions.'),
    specialist('ledger', 'Ledger', 'COO', 'Maintain an evidence-backed operating ledger of revenue, costs, obligations, outcomes, and reconciliation status.'),
    specialist('pricing', 'Pricing', 'COO', 'Analyze packaging, price points, discounts, margins, willingness-to-pay evidence, and pricing experiments.'),
    specialist('procurement', 'Procurement', 'COO', 'Evaluate vendors, subscriptions, terms, usage, redundancy, and procurement decisions against requirements and cost.'),
    specialist('contracts', 'Contracts', 'COO', 'Track contract requirements, commercial terms, obligations, renewal dates, and issues requiring legal or human review.'),
    specialist('entity-manager', 'EntityManager', 'COO', 'Track business entities, registrations, ownership or admin tasks, filings, and compliance calendars.'),
    specialist('investor-relations', 'InvestorRelations', 'COO', 'Prepare factual investor materials, data-room checklists, updates, metrics, and outreach research without fabricating traction.'),
    specialist('grant-scout', 'GrantScout', 'LEAD_RESEARCH', 'Find relevant grant and funding programs, eligibility requirements, deadlines, evidence needs, and application tasks.'),
    specialist('metrics', 'Metrics', 'COO', 'Define and maintain KPI definitions, source systems, reporting cadence, targets, and anomaly detection.'),
  ],
};
