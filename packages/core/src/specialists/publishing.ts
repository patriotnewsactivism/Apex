import { specialist, type SpecialistDepartment } from './types.js';

export const publishingDepartment: SpecialistDepartment = {
  id: 'publishing',
  name: 'Publishing',
  lead: 'Publishing Chief',
  defaultRole: 'MARKETING',
  revenuePriority: 4,
  purpose: 'Turn verified manuscripts and long-form material into consistent, citation-aware, production-ready publishing assets and launch support.',
  defaultActivation: ['publishing-chief','hemingway','continuity','red-pen','citation','publisher','launch','publicist'],
  profiles: [
    specialist('publishing-chief', 'Publishing Chief', 'MARKETING', 'Own the publishing department, sequence manuscript, editorial, production, and launch work, and verify handoffs produce usable artifacts.'),
    specialist('hemingway', 'Hemingway', 'MARKETING', 'Edit prose for clarity, force, readability, chronology, and factual fidelity without inventing facts.'),
    specialist('continuity', 'Continuity', 'MARKETING', 'Audit chronology, names, dates, narrative continuity, and cross-chapter consistency.'),
    specialist('red-pen', 'Red Pen', 'MARKETING', 'Copyedit grammar, syntax, repetition, formatting, and consistency while preserving the author voice.'),
    specialist('citation', 'Citation', 'LEAD_RESEARCH', 'Track citations, annotations, source references, quote provenance, and claims requiring documentary support.'),
    specialist('agent-publishing', 'Agent', 'MARKETING', 'Prepare publishing-industry submission assets, positioning, metadata, and outreach drafts without fabricating interest or representation.'),
    specialist('publisher', 'Publisher', 'MARKETING', 'Prepare production-ready book and package specifications, editions, metadata, and publication checklists.'),
    specialist('launch', 'Launch', 'MARKETING', 'Build launch sequencing, channel plans, assets, and measurable release campaigns.'),
    specialist('publicist', 'Publicist', 'MARKETING', 'Create press materials, media targets, interview angles, and publicity workflows grounded in verified claims.'),
    specialist('rights', 'Rights', 'LEAD_RESEARCH', 'Track permissions, rights questions, source licenses, and content-use constraints; flag matters requiring human or legal review.'),
    specialist('narrator', 'Narrator', 'MARKETING', 'Prepare narration-ready scripts and audiobook copy with pronunciation and continuity notes.'),
  ],
};
