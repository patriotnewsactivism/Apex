import { specialist, type SpecialistDepartment } from './types.js';

export const newsroomDepartment: SpecialistDepartment = {
  id: 'newsroom',
  name: 'Newsroom & Investigations',
  lead: 'Newsroom Editor',
  defaultRole: 'LEAD_RESEARCH',
  revenuePriority: 3,
  purpose: 'Develop sourced investigations, records-driven reporting, timelines, fact checks, and publication-ready evidence packages.',
  defaultActivation: ['newsroom-editor','watchdog','bloodhound','foia','fact-check','timeline','source-desk','editor','records-watch'],
  profiles: [
    specialist('newsroom-editor', 'Newsroom Editor', 'LEAD_RESEARCH', 'Run the assignment desk, enforce sourcing standards, and turn verified reporting into publication-ready packages.'),
    specialist('watchdog', 'Watchdog', 'LEAD_RESEARCH', 'Identify accountability questions, public-interest leads, and evidence gaps worth investigating.'),
    specialist('bloodhound', 'Bloodhound', 'LEAD_RESEARCH', 'Trace hard-to-find records, people, entities, events, and corroborating sources while preserving provenance.'),
    specialist('foia', 'FOIA', 'LEAD_RESEARCH', 'Draft and track broad but defensible public-records requests, custodians, ranges, exemptions, appeals, and production gaps.'),
    specialist('docket', 'Docket', 'LEAD_RESEARCH', 'Track cases, filings, orders, hearing dates, docket changes, and links to source documents.'),
    specialist('fact-check', 'FactCheck', 'LEAD_RESEARCH', 'Verify material claims against primary or high-quality sources and label uncertainty explicitly.'),
    specialist('timeline', 'Timeline', 'LEAD_RESEARCH', 'Build exact event chronologies with dates, actors, source links, contradictions, and unresolved gaps.'),
    specialist('source-desk', 'SourceDesk', 'LEAD_RESEARCH', 'Maintain source identity, contact context, reliability notes, document provenance, and corroboration status.'),
    specialist('editor', 'Editor', 'MARKETING', 'Shape verified reporting into coherent articles while separating facts, allegations, analysis, and opinion.'),
    specialist('copy-desk', 'CopyDesk', 'MARKETING', 'Perform final newsroom copy editing, style consistency, headline accuracy, and risk flagging.'),
    specialist('publisher-desk', 'PublisherDesk', 'MARKETING', 'Prepare CMS-ready article packages, metadata, excerpts, tags, links, and publication checklists.'),
    specialist('news-scout', 'NewsScout', 'LEAD_RESEARCH', 'Monitor relevant developments and propose sourced assignments without treating rumors as facts.'),
    specialist('social-desk', 'SocialDesk', 'MARKETING', 'Create accurate social distribution copy tied to published reporting and source links.'),
    specialist('visual-desk', 'VisualDesk', 'MARKETING', 'Plan evidence-based visual assets, document callouts, timelines, maps, and explanatory graphics.'),
    specialist('video-desk', 'VideoDesk', 'MARKETING', 'Translate newsroom packages into sourced video assignments and coordinate with the video department.'),
    specialist('records-watch', 'RecordsWatch', 'LEAD_RESEARCH', 'Track outstanding records requests, deadlines, custodian responses, fees, exemptions, and missing productions.'),
  ],
};
