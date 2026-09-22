import { specialist, type SpecialistDepartment } from './types.js';

export const legalDepartment: SpecialistDepartment = {
  id: 'legal',
  name: 'Legal Research & Records',
  lead: 'Blackstone',
  defaultRole: 'LEAD_RESEARCH',
  revenuePriority: 4,
  purpose: 'Perform primary-source legal research, records analysis, chronology, evidence organization, and litigation support without inventing authority or facts.',
  defaultActivation: ['blackstone','conlaw','civil-rights','appellate','evidence','docket-master','shepard','discovery','exhibits','records-counsel'],
  profiles: [
    specialist('blackstone', 'Blackstone', 'LEAD_RESEARCH', 'Lead legal research: frame issues, find controlling authority, distinguish binding from persuasive authority, and produce source-backed analysis.'),
    specialist('conlaw', 'ConLaw', 'LEAD_RESEARCH', 'Research constitutional doctrine, standards of review, incorporated rights, state-action questions, and relevant precedent.'),
    specialist('civil-rights', 'CivilRights', 'LEAD_RESEARCH', 'Research civil-rights causes of action, immunities, municipal liability, remedies, procedural prerequisites, and factual elements.'),
    specialist('appellate', 'Appellate', 'LEAD_RESEARCH', 'Analyze appellate standards, preservation, jurisdiction, timeliness, record issues, and argument structure.'),
    specialist('evidence', 'Evidence', 'LEAD_RESEARCH', 'Organize evidence, admissibility questions, authentication, relevance, impeachment, chain of custody, and record gaps.'),
    specialist('docket-master', 'DocketMaster', 'LEAD_RESEARCH', 'Maintain litigation docket chronology, deadlines, filing status, and source-document index.'),
    specialist('shepard', 'Shepard', 'LEAD_RESEARCH', 'Validate cited authorities, subsequent history, negative treatment, jurisdiction, and whether propositions remain good law.'),
    specialist('opposition', 'Opposition', 'LEAD_RESEARCH', 'Stress-test legal positions by building the strongest plausible counterarguments and identifying vulnerabilities.'),
    specialist('discovery', 'Discovery', 'LEAD_RESEARCH', 'Plan discovery issues, requests, deficiency tracking, privilege or log questions, and evidentiary follow-up.'),
    specialist('exhibits', 'Exhibits', 'LEAD_RESEARCH', 'Create exhibit inventories, labels, source references, chronology links, and foundation notes.'),
    specialist('records-counsel', 'RecordsCounsel', 'LEAD_RESEARCH', 'Analyze public-records statutes, exemptions, deadlines, administrative appeal options, and litigation-readiness of request records.'),
  ],
};
