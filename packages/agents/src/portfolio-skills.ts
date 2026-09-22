export interface PortfolioSkillDefinition {
  id: string;
  name: string;
  instruction: string;
}

export const PORTFOLIO_SKILLS: Record<string, PortfolioSkillDefinition> = {
  'source-verification': {
    id: 'source-verification',
    name: 'Source Verification',
    instruction: 'Verify material against primary or authoritative sources when possible; preserve the supporting URL or repository/file reference and distinguish verified fact from inference.',
  },
  'no-invention-nonfiction': {
    id: 'no-invention-nonfiction',
    name: 'No-Invention Nonfiction',
    instruction: 'For factual nonfiction, never invent dialogue, dates, motives, quotations, events, or connective details. Flag gaps and preserve uncertainty.',
  },
  'legal-citation-verification': {
    id: 'legal-citation-verification',
    name: 'Legal Citation Verification',
    instruction: 'Check legal propositions against controlling or persuasive authority and verify citations, court, date, posture, and quoted language before relying on them.',
  },
  'foia-drafting': {
    id: 'foia-drafting',
    name: 'FOIA / Public Records Drafting',
    instruction: 'Draft precise, records-oriented requests with date ranges, custodians, systems, metadata, retention sources, and segregability language while avoiding unsupported accusations.',
  },
  'investigative-timeline': {
    id: 'investigative-timeline',
    name: 'Investigative Timeline',
    instruction: 'Build chronology from source-backed events, record conflicts explicitly, and retain source provenance for every material event.',
  },
  'apex-repo-audit': {
    id: 'apex-repo-audit',
    name: 'APEX Repository Audit',
    instruction: 'Inspect the current repository state before proposing changes; verify architecture, runtime path, tests, deployment constraints, and operational safeguards rather than assuming them.',
  },
  'production-deployment': {
    id: 'production-deployment',
    name: 'Production Deployment',
    instruction: 'Use the repository deployment contract, immutable reviewed revisions, health verification, rollback readiness, and human approval where the existing policy requires it.',
  },
  'regression-test': {
    id: 'regression-test',
    name: 'Regression Test',
    instruction: 'Test changed behavior plus adjacent critical paths, record reproducible evidence, and separate verified failures from hypotheses.',
  },
  'lead-research': {
    id: 'lead-research',
    name: 'Lead Research',
    instruction: 'Use real public business sources, deduplicate, verify contact paths, never guess contact details, and preserve the source supporting each lead.',
  },
  'account-qualification': {
    id: 'account-qualification',
    name: 'Account Qualification',
    instruction: 'Qualify against an explicit ICP and evidence. Record why an account fits, what is unknown, and the best verified path to contact it.',
  },
  'article-publication': {
    id: 'article-publication',
    name: 'Article Publication',
    instruction: 'Keep reporting evidence-first and publication-ready, but treat actual external publication as a governed side effect requiring the applicable approval.',
  },
  'seo-audit': {
    id: 'seo-audit',
    name: 'SEO Audit',
    instruction: 'Evaluate crawlability, metadata, indexation, internal linking, content intent, structured data, performance, and conversion paths using current observed evidence.',
  },
  'book-chapter-qa': {
    id: 'book-chapter-qa',
    name: 'Book Chapter QA',
    instruction: 'Check chronology, factual consistency, citations/annotations, names, dates, duplicated scenes, and unsupported embellishment while preserving the author’s voice.',
  },
  'press-release': {
    id: 'press-release',
    name: 'Press Release',
    instruction: 'Draft concise, fact-grounded media copy with a verifiable news hook and contact/context fields; external distribution remains approval-gated.',
  },
  'evidence-indexing': {
    id: 'evidence-indexing',
    name: 'Evidence Indexing',
    instruction: 'Create stable evidence identifiers, preserve original filenames/source links, dates, hashes or checksums when available, and map each item to the proposition or event it supports.',
  },
  'cost-audit': {
    id: 'cost-audit',
    name: 'Cost Audit',
    instruction: 'Reconcile provider, infrastructure, and campaign cost evidence against actual usage; surface waste, retries, failed work, and unallocated spend without inventing savings.',
  },
  'morning-executive-brief': {
    id: 'morning-executive-brief',
    name: 'Morning Executive Brief',
    instruction: 'Synthesize verified overnight changes, blocked work, incidents, revenue/pipeline movement, content opportunities, approvals needing attention, and the highest-impact next actions.',
  },
  'video-provenance': {
    id: 'video-provenance',
    name: 'Video Provenance',
    instruction: 'For every external clip preserve the original/canonical source URL, source account or site, title, publication/upload date when available, access date, exact timecode used, and licensing/fair-use uncertainty. Never treat a repost as the original when the original can be identified.',
  },
};

export function renderPortfolioSkills(skillIds: readonly string[] | undefined): string {
  if (!skillIds?.length) return 'No additional shared skill pack assigned.';
  return skillIds
    .map((id) => PORTFOLIO_SKILLS[id])
    .filter((skill): skill is PortfolioSkillDefinition => Boolean(skill))
    .map((skill) => `- ${skill.name}: ${skill.instruction}`)
    .join('\n');
}
