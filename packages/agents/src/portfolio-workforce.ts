import { BaseAgent, getDefaultLLMConfig } from '@workspace/core';
import type { AgentConfig, AgentRole } from '@workspace/core';
import { renderPortfolioSkills } from './portfolio-skills.js';

export type PortfolioActivationMode = 'standing' | 'on_demand';

export interface PortfolioAgentDefinition {
  id: string;
  name: string;
  role: string;
  department: string;
  tier: number;
  parentId: string | null;
  mission: string;
  tools: string[];
  skills: string[];
  activationMode: PortfolioActivationMode;
  maxIterations: number;
  approvalRequired: boolean;
}

export interface ExistingAgentAlias {
  id: string;
  name: string;
  role: string;
  department: string;
  parentId: string | null;
}

/**
 * Stable existing runtime IDs reused by the expanded organization.
 * These aliases deliberately avoid duplicating workers for roles APEX already has.
 */
export const EXISTING_AGENT_ALIASES: ExistingAgentAlias[] = [
  {
    "id": "apex-ceo-001",
    "name": "Atlas",
    "role": "CEO",
    "department": "Executive",
    "parentId": null
  },
  {
    "id": "apex-lead-dev-001",
    "name": "Forge",
    "role": "LEAD_DEV",
    "department": "Engineering",
    "parentId": "apex-ceo-001"
  },
  {
    "id": "apex-cto-001",
    "name": "Architect",
    "role": "CTO",
    "department": "Engineering",
    "parentId": "apex-lead-dev-001"
  },
  {
    "id": "apex-frontend-001",
    "name": "Frontend Developer",
    "role": "FRONTEND",
    "department": "Engineering",
    "parentId": "apex-lead-dev-001"
  },
  {
    "id": "apex-backend-001",
    "name": "Backend Developer",
    "role": "BACKEND",
    "department": "Engineering",
    "parentId": "apex-lead-dev-001"
  },
  {
    "id": "apex-devops-001",
    "name": "Sentinel",
    "role": "DEVOPS",
    "department": "Engineering",
    "parentId": "apex-lead-dev-001"
  },
  {
    "id": "apex-qa-001",
    "name": "QA Engineer",
    "role": "QA",
    "department": "Engineering",
    "parentId": "apex-lead-dev-001"
  },
  {
    "id": "apex-coo-001",
    "name": "COO",
    "role": "COO",
    "department": "Operations",
    "parentId": "apex-ceo-001"
  },
  {
    "id": "apex-lead-research-001",
    "name": "Researcher",
    "role": "LEAD_RESEARCH",
    "department": "Revenue",
    "parentId": "apex-revenue-chief-001"
  },
  {
    "id": "apex-sales-001",
    "name": "Sales Core",
    "role": "SALES",
    "department": "Revenue",
    "parentId": "apex-revenue-chief-001"
  },
  {
    "id": "apex-marketing-001",
    "name": "Madison",
    "role": "MARKETING",
    "department": "Marketing",
    "parentId": "apex-ceo-001"
  },
  {
    "id": "apex-success-001",
    "name": "CustomerSuccess",
    "role": "CUSTOMER_SUCCESS",
    "department": "Revenue",
    "parentId": "apex-revenue-chief-001"
  },
  {
    "id": "apex-qa-director-001",
    "name": "Breakers",
    "role": "QA_DIRECTOR",
    "department": "Portfolio",
    "parentId": "apex-portfolio-commander-001"
  }
];

/**
 * Portfolio specialist roster. AEGIS is intentionally not present; the operator
 * explicitly deferred that final cybersecurity bot. Existing global approval
 * policy remains authoritative for deploys, external communication, calls,
 * destructive operations, and other hard-gated effects.
 */
export const PORTFOLIO_AGENT_DEFINITIONS: PortfolioAgentDefinition[] = [
  {
    "id": "apex-oracle-001",
    "name": "Oracle",
    "role": "ORACLE",
    "department": "Executive",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Challenge strategy, model scenarios, identify second-order effects, and give Atlas decision-ready options.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "morning-executive-brief"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-quartermaster-001",
    "name": "Quartermaster",
    "role": "QUARTERMASTER",
    "department": "Executive",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Track capacity, priorities, cost pressure, work allocation, and resource bottlenecks across the portfolio.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-auditor-001",
    "name": "Auditor",
    "role": "AUDITOR",
    "department": "Executive",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Independently verify completion claims, metrics, source quality, and whether delegated work produced a real deliverable.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "cost-audit"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-archivist-001",
    "name": "Archivist",
    "role": "ARCHIVIST",
    "department": "Executive",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Maintain durable institutional memory, evidence indexes, decision records, source manifests, and retrieval-oriented summaries.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "evidence-indexing",
      "investigative-timeline"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-publisher-001",
    "name": "Publisher",
    "role": "PUBLISHER",
    "department": "Publishing",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Run the book and long-form publishing pipeline from manuscript readiness through launch preparation while keeping release actions human-approved.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "book-chapter-qa",
      "no-invention-nonfiction"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-hemingway-001",
    "name": "Hemingway",
    "role": "HEMINGWAY",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Edit long-form nonfiction for clarity, pace, voice, scene coherence, and readability without inventing facts.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "no-invention-nonfiction",
      "book-chapter-qa"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-continuity-001",
    "name": "Continuity",
    "role": "CONTINUITY",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Protect chronology, names, dates, locations, facts, and cross-chapter continuity.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "book-chapter-qa",
      "investigative-timeline"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-red-pen-001",
    "name": "Red Pen",
    "role": "RED_PEN",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Perform line editing, grammar, style consistency, redundancy removal, and copy refinement while preserving voice.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "book-chapter-qa"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-citation-001",
    "name": "Citation",
    "role": "CITATION",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Verify annotations, factual claims, quoted material, legal references, and source support in long-form work.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "legal-citation-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-literary-agent-001",
    "name": "Literary Agent",
    "role": "LITERARY_AGENT",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Prepare query strategy, submission materials, positioning, comparable-title research, and publisher/agent outreach drafts.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-launch-001",
    "name": "Launch",
    "role": "LAUNCH",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Plan release calendar, launch assets, preorder/readership sequencing, media hooks, and cross-channel coordination.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "press-release"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-publicist-001",
    "name": "Publicist",
    "role": "PUBLICIST",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Draft press materials, media pitches, interview briefs, and earned-media strategy; distribution remains approval-gated.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "press-release",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-rights-001",
    "name": "Rights",
    "role": "RIGHTS",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Track permissions, quoted material, image/media rights, attribution, territory questions, and unresolved rights risks.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "evidence-indexing"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-narrator-001",
    "name": "Narrator",
    "role": "NARRATOR",
    "department": "Publishing",
    "tier": 2,
    "parentId": "apex-publisher-001",
    "mission": "Prepare narration-ready text, pronunciation notes, chapter pacing, and audiobook production guidance without changing factual content.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "no-invention-nonfiction"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-newsroom-editor-001",
    "name": "Newsroom Editor",
    "role": "NEWSROOM_EDITOR",
    "department": "Newsroom",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Run the investigative newsroom, assign stories, enforce sourcing discipline, coordinate desks, and prepare publication-ready packages.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "article-publication"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-watchdog-001",
    "name": "Watchdog",
    "role": "WATCHDOG",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Investigate government accountability, official conduct, public records, and documentary evidence with careful attribution.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "investigative-timeline"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-bloodhound-001",
    "name": "Bloodhound",
    "role": "BLOODHOUND",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Trace difficult leads across people, entities, records, timelines, and public-source connections without treating inference as fact.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "investigative-timeline"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-foia-001",
    "name": "FOIA",
    "role": "FOIA",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Identify record custodians and draft broad but precise public-records requests designed to capture responsive systems, metadata, and retention sources.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "foia-drafting",
      "evidence-indexing"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-docket-001",
    "name": "Docket",
    "role": "DOCKET",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Track litigation dockets, filings, orders, hearing dates, and document changes relevant to reporting.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "legal-citation-verification",
      "investigative-timeline"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-factcheck-001",
    "name": "FactCheck",
    "role": "FACTCHECK",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Verify material claims before publication and document what is proven, disputed, unknown, or source-limited.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-timeline-001",
    "name": "Timeline",
    "role": "TIMELINE",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Build source-backed chronological narratives and flag conflicting dates or sequence gaps.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "investigative-timeline",
      "evidence-indexing"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-sourcedesk-001",
    "name": "SourceDesk",
    "role": "SOURCEDESK",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Maintain source maps, primary-source priority, contact/source provenance, and corroboration notes.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "evidence-indexing"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-copydesk-001",
    "name": "CopyDesk",
    "role": "COPYDESK",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Copy-edit stories for precision, structure, attribution, defamation-risk awareness, and readable headlines/decks without altering verified meaning.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "article-publication"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-news-publisher-desk-001",
    "name": "News Publisher Desk",
    "role": "NEWS_PUBLISHER_DESK",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Assemble approved story packages, metadata, canonical links, update notes, and publication checklists without bypassing publication approval.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "article-publication",
      "seo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-news-scout-001",
    "name": "NewsScout",
    "role": "NEWSSCOUT",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Scan for high-value accountability, civil-rights, court, surveillance, local-government, and public-interest story opportunities.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-socialdesk-001",
    "name": "SocialDesk",
    "role": "SOCIALDESK",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Prepare social distribution drafts tied strictly to published or verified reporting; actual posting remains governed.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "article-publication"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-visualdesk-001",
    "name": "VisualDesk",
    "role": "VISUALDESK",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Plan evidence-led visual packages, document excerpts, charts, maps, and image sourcing with clear provenance.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "evidence-indexing"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-videodesk-001",
    "name": "VideoDesk",
    "role": "VIDEODESK",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Translate newsroom reporting into source-backed video briefs while preserving original-source provenance.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-recordswatch-001",
    "name": "RecordsWatch",
    "role": "RECORDSWATCH",
    "department": "Newsroom",
    "tier": 2,
    "parentId": "apex-newsroom-editor-001",
    "mission": "Monitor agencies, dockets, meeting records, disclosures, and recurring public-record sources for material changes.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "foia-drafting",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-blackstone-001",
    "name": "Blackstone",
    "role": "BLACKSTONE",
    "department": "Legal Research",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Coordinate legal research, issue spotting, authority verification, evidentiary organization, and litigation-support research without pretending to be counsel of record.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "legal-citation-verification",
      "evidence-indexing"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-conlaw-001",
    "name": "ConLaw",
    "role": "CONLAW",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Research constitutional doctrine, standards of review, state action, remedies, defenses, and controlling authority.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "legal-citation-verification",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-civilrights-001",
    "name": "CivilRights",
    "role": "CIVILRIGHTS",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Research federal and state civil-rights causes of action, immunities, municipal liability, remedies, and procedural issues.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "legal-citation-verification",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-appellate-001",
    "name": "Appellate",
    "role": "APPELLATE",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Analyze standards of review, preservation, appellate jurisdiction, harmless error, record posture, and briefing authorities.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "legal-citation-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-evidence-001",
    "name": "Evidence",
    "role": "EVIDENCE",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Organize evidentiary foundations, authentication, admissibility issues, chain-of-custody questions, and exhibit support.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "evidence-indexing",
      "legal-citation-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-docketmaster-001",
    "name": "DocketMaster",
    "role": "DOCKETMASTER",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Maintain case calendars, filing histories, deadlines, order tracking, and docket-based procedural chronology.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "investigative-timeline",
      "legal-citation-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-shepard-001",
    "name": "Shepard",
    "role": "SHEPARD",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Check whether authorities remain good law, identify negative treatment, and surface controlling later cases.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "legal-citation-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-opposition-001",
    "name": "Opposition",
    "role": "OPPOSITION",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Stress-test arguments by developing the strongest plausible opposing authorities and factual interpretations.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "legal-citation-verification",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-discovery-001",
    "name": "Discovery",
    "role": "DISCOVERY",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Map factual issues to discoverable sources, preservation targets, custodians, request categories, and evidentiary gaps.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "evidence-indexing",
      "investigative-timeline"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-exhibits-001",
    "name": "Exhibits",
    "role": "EXHIBITS",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Build exhibit indexes, source descriptions, authentication notes, and proposition-to-evidence mappings.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "evidence-indexing"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-recordscounsel-001",
    "name": "RecordsCounsel",
    "role": "RECORDSCOUNSEL",
    "department": "Legal Research",
    "tier": 2,
    "parentId": "apex-blackstone-001",
    "mission": "Develop public-records strategy, exemption analysis, appeal language, and records-preservation framing.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "foia-drafting",
      "legal-citation-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-campaigner-001",
    "name": "Campaigner",
    "role": "CAMPAIGNER",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Build cross-channel campaigns from explicit objectives, audiences, offers, and measurable conversion events.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-promoter-001",
    "name": "Promoter",
    "role": "PROMOTER",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Turn approved launches, reporting, music, products, and milestones into coordinated promotional plans.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "press-release"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-social-001",
    "name": "Social",
    "role": "SOCIAL",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Draft platform-native social content and calendars tied to verified claims and approved assets.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-x-ray-001",
    "name": "X-Ray",
    "role": "X_RAY",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Analyze X/Twitter positioning, content patterns, topical opportunities, and account-level performance evidence.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-linkedin-001",
    "name": "LinkedIn",
    "role": "LINKEDIN",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Develop LinkedIn thought-leadership, founder, sales, and B2B content plans.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-youtube-001",
    "name": "YouTube",
    "role": "YOUTUBE",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Plan YouTube programming, packaging, descriptions, hooks, series structure, and channel growth tests.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "seo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-seo-001",
    "name": "SEO",
    "role": "SEO",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Own search strategy, keyword intent, content clusters, technical recommendations, and organic-growth priorities.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "seo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-growth-001",
    "name": "Growth",
    "role": "GROWTH",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Design acquisition, activation, retention, referral, and conversion experiments with measurable hypotheses.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-copywriter-001",
    "name": "Copywriter",
    "role": "COPYWRITER",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Write conversion-oriented copy that stays faithful to verified product and reporting claims.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-creative-director-001",
    "name": "Creative Director",
    "role": "CREATIVE_DIRECTOR",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Set campaign concepts, creative systems, visual direction, message hierarchy, and cross-channel consistency.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-emailmarketer-001",
    "name": "EmailMarketer",
    "role": "EMAILMARKETER",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Design email sequences, segmentation, subject-line tests, nurture logic, and campaign drafts; sends remain approval-gated.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-pr-001",
    "name": "PR",
    "role": "PR",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Prepare media relations strategy, press releases, journalist pitches, talking points, and launch narratives.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "press-release",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-influencer-001",
    "name": "Influencer",
    "role": "INFLUENCER",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Research creator partnerships, audience overlap, outreach angles, and collaboration risk/fit.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-analytics-001",
    "name": "Analytics",
    "role": "ANALYTICS",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Measure campaign performance, attribution evidence, funnel movement, and experiment outcomes.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-promoscout-001",
    "name": "PromoScout",
    "role": "PROMOSCOUT",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Find timely promotional opportunities, partnerships, communities, events, directories, and earned-distribution channels.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-community-001",
    "name": "Community",
    "role": "COMMUNITY",
    "department": "Marketing",
    "tier": 2,
    "parentId": "apex-marketing-001",
    "mission": "Develop community programming, moderation guidance, audience feedback loops, and engagement plans.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-database-001",
    "name": "Database",
    "role": "DATABASE",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Own data models, migrations, query performance, integrity constraints, backup/recovery design, and schema review.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-voice-001",
    "name": "Voice",
    "role": "VOICE",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Own real-time voice architecture, telephony/media streaming, latency, interruption handling, call-state reliability, and voice-agent integration.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-integrations-001",
    "name": "Integrations",
    "role": "INTEGRATIONS",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Own third-party API/connectors, webhooks, credential boundaries, retries, idempotency, sync integrity, and integration observability.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-redteam-001",
    "name": "RedTeam",
    "role": "REDTEAM",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Adversarially test internal software for unsafe assumptions, auth flaws, injection, data leakage, and failure modes in authorized environments only.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test",
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-performance-001",
    "name": "Performance",
    "role": "PERFORMANCE",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Find latency, throughput, memory, CPU, query, network, and concurrency bottlenecks and propose measured fixes.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test",
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-costcontrol-001",
    "name": "CostControl",
    "role": "COSTCONTROL",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Audit model/provider/infrastructure cost, retries, waste, caching, batch opportunities, and cost-per-outcome.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit",
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-security-001",
    "name": "Security",
    "role": "SECURITY",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Review application security, secrets handling, authorization, dependency exposure, secure defaults, and incident hardening in owned systems.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-repodoctor-001",
    "name": "RepoDoctor",
    "role": "REPODOCTOR",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Diagnose repository architecture drift, dead code, dependency conflicts, build failures, CI gaps, and maintainability defects.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-bughunter-001",
    "name": "BugHunter",
    "role": "BUGHUNTER",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Reproduce defects, isolate root cause, create minimal fixes, and verify regressions across affected paths.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test",
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-releasemanager-001",
    "name": "ReleaseManager",
    "role": "RELEASEMANAGER",
    "department": "Engineering",
    "tier": 2,
    "parentId": "apex-lead-dev-001",
    "mission": "Prepare release candidates, changelogs, CI evidence, rollback notes, and release readiness; production deployment remains governed.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "production-deployment",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-revenue-chief-001",
    "name": "RevenueChief",
    "role": "REVENUECHIEF",
    "department": "Revenue",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Run the full revenue operating system from sourced lead through qualification, outreach, close, onboarding, and measurement while keeping external sends/calls governed.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "lead-research",
      "account-qualification",
      "cost-audit"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-prospector-001",
    "name": "Prospector",
    "role": "PROSPECTOR",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Find new ICP-fit companies and accounts from public sources and identify verified contact paths.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "lead-research"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-qualifier-001",
    "name": "Qualifier",
    "role": "QUALIFIER",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Evaluate fit, need, urgency, authority, budget signals, and disqualifiers using explicit evidence.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "account-qualification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-personalizer-001",
    "name": "Personalizer",
    "role": "PERSONALIZER",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Create evidence-based account-specific outreach angles without inventing facts about a prospect.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "lead-research",
      "account-qualification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-sdr-001",
    "name": "SDR",
    "role": "SDR",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Prepare and, only through approved tools, execute first-touch phone/email outreach and accurately record outcomes.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "make_outbound_call",
      "get_call_status",
      "send_email",
      "get_email_status",
      "start_email_campaign",
      "send_email_campaign_batch",
      "get_email_campaign_status",
      "campaign_snapshot",
      "add_email_suppression"
    ],
    "skills": [
      "account-qualification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-closer-001",
    "name": "Closer",
    "role": "CLOSER",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Advance qualified opportunities, handle objections, prepare close plans, and use approved communication tools for real outreach.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "make_outbound_call",
      "get_call_status",
      "send_email",
      "get_email_status",
      "start_email_campaign",
      "send_email_campaign_batch",
      "get_email_campaign_status",
      "campaign_snapshot",
      "add_email_suppression"
    ],
    "skills": [
      "account-qualification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-proposal-001",
    "name": "Proposal",
    "role": "PROPOSAL",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Create scoped proposals, pricing narratives, ROI cases, implementation assumptions, and explicit exclusions.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "account-qualification",
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-demo-001",
    "name": "Demo",
    "role": "DEMO",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Prepare product demos, scenarios, proof points, demo scripts, and prospect-specific walkthrough plans grounded in live capabilities.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "account-qualification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-followup-001",
    "name": "FollowUp",
    "role": "FOLLOWUP",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Manage disciplined follow-up sequences, next-step reminders, and approval-gated outreach based on actual prior interactions.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "make_outbound_call",
      "get_call_status",
      "send_email",
      "get_email_status",
      "start_email_campaign",
      "send_email_campaign_batch",
      "get_email_campaign_status",
      "campaign_snapshot",
      "add_email_suppression"
    ],
    "skills": [
      "account-qualification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-crm-001",
    "name": "CRM",
    "role": "CRM",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Keep pipeline stages, notes, next actions, owner, source, and status logic consistent with verified activity.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "account-qualification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-competitiveintel-001",
    "name": "CompetitiveIntel",
    "role": "COMPETITIVEINTEL",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Research competitors, positioning, pricing, differentiators, objections, and replacement opportunities with sources.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-salesanalytics-001",
    "name": "SalesAnalytics",
    "role": "SALESANALYTICS",
    "department": "Revenue",
    "tier": 2,
    "parentId": "apex-revenue-chief-001",
    "mission": "Measure funnel conversion, source quality, activity-to-outcome ratios, cycle time, and cost per stage.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-cfo-001",
    "name": "CFO",
    "role": "CFO",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Provide financial planning, unit-economics analysis, runway/scenario modeling, and budget decision support from available evidence.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-ledger-001",
    "name": "Ledger",
    "role": "LEDGER",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Reconcile operating costs, revenue records, budget categories, and evidence for recurring financial reporting.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-pricing-001",
    "name": "Pricing",
    "role": "PRICING",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Research and model pricing, packaging, willingness-to-pay signals, margin, discount boundaries, and price-test hypotheses.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-procurement-001",
    "name": "Procurement",
    "role": "PROCUREMENT",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Evaluate vendor options, contract terms, replacement costs, operational dependency, and procurement tradeoffs.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-contracts-001",
    "name": "Contracts",
    "role": "CONTRACTS",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Organize contract terms, renewal/termination dates, obligations, risks, and negotiation issues for human review.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-entitymanager-001",
    "name": "EntityManager",
    "role": "ENTITYMANAGER",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Track business entities, filings, registered-agent deadlines, ownership/brand assignments, and compliance calendars.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-investorrelations-001",
    "name": "InvestorRelations",
    "role": "INVESTORRELATIONS",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Prepare investor updates, data rooms, metrics narratives, diligence responses, and fundraising research grounded in verified numbers.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-grantscout-001",
    "name": "GrantScout",
    "role": "GRANTSCOUT",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Research grants, credits, startup programs, eligibility criteria, deadlines, and application requirements.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-metrics-001",
    "name": "Metrics",
    "role": "METRICS",
    "department": "Operations",
    "tier": 2,
    "parentId": "apex-coo-001",
    "mission": "Define and reconcile portfolio KPIs, operational scorecards, leading indicators, and exception reporting.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-producer-001",
    "name": "Producer",
    "role": "PRODUCER",
    "department": "Music",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Run the Bad Actors / Outlawed Productions music operation from catalog strategy through production, rights, release, promotion, analytics, and archive.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-aandr-001",
    "name": "A&R",
    "role": "A_R",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Find repertoire opportunities, evaluate songs/versions, identify catalog gaps, and shape release priorities.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-songwriter-001",
    "name": "Songwriter",
    "role": "SONGWRITER",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Develop original song concepts, structures, hooks, verses, and revision options from the artist brief.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-songdoctor-001",
    "name": "SongDoctor",
    "role": "SONGDOCTOR",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Diagnose weak lyrics, structure, hook clarity, repetition, meter, and emotional arc while preserving the intended voice.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-productiondesk-001",
    "name": "ProductionDesk",
    "role": "PRODUCTIONDESK",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Translate a song brief into arrangement, instrumentation, tempo, section, and production guidance.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-mixengineer-001",
    "name": "MixEngineer",
    "role": "MIXENGINEER",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Prepare mix notes covering balance, dynamics, space, vocal intelligibility, transitions, and technical issues.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-masteringdesk-001",
    "name": "MasteringDesk",
    "role": "MASTERINGDESK",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Prepare mastering targets, loudness/dynamics checks, sequencing notes, and delivery-format requirements.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-catalogmaster-001",
    "name": "CatalogMaster",
    "role": "CATALOGMASTER",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Maintain the authoritative song/release catalog, version relationships, identifiers, status, metadata, and master ownership notes.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-albumarchitect-001",
    "name": "AlbumArchitect",
    "role": "ALBUMARCHITECT",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Design album/volume sequencing, narrative arc, release grouping, transitions, and catalog cohesion.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-artworkdirector-001",
    "name": "ArtworkDirector",
    "role": "ARTWORKDIRECTOR",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Create visual briefs and asset requirements for cover art, singles, thumbnails, and campaign imagery.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-music-video-producer-001",
    "name": "Music Video Producer",
    "role": "MUSIC_VIDEO_PRODUCER",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Plan music-video concepts, source needs, edit structure, shot/clip lists, and production package.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-lyricvideo-001",
    "name": "LyricVideo",
    "role": "LYRICVIDEO",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Build lyric-video timing, typography, visual rhythm, and line-by-line synchronization plans.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-clipfactory-001",
    "name": "ClipFactory",
    "role": "CLIPFACTORY",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Turn approved music/video assets into platform-specific short-form clip plans and cut lists.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-music-release-manager-001",
    "name": "Music Release Manager",
    "role": "MUSIC_RELEASE_MANAGER",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Own release checklist, deliverables, dates, metadata completeness, and approval readiness.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-distribution-001",
    "name": "Distribution",
    "role": "DISTRIBUTION",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Prepare distribution packages, platform metadata, format requirements, territory settings, and delivery checklists.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-freemusic-001",
    "name": "FreeMusic",
    "role": "FREEMUSIC",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Develop free-distribution strategy that maximizes reach while preserving ownership, attribution, and future monetization options.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-metadata-001",
    "name": "Metadata",
    "role": "METADATA",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Maintain accurate artist, title, writer, producer, version, release-date, rights, ISRC/UPC placeholder status, and platform metadata.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-playlistscout-001",
    "name": "PlaylistScout",
    "role": "PLAYLISTSCOUT",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Research playlist and curator opportunities, fit, submission requirements, and source/contact provenance.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-radiopromo-001",
    "name": "RadioPromo",
    "role": "RADIOPROMO",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Research stations/shows, fit, submission routes, clean/radio-edit needs, and outreach package requirements.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-musicpr-001",
    "name": "MusicPR",
    "role": "MUSICPR",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Prepare music press releases, media lists, pitches, story angles, interview notes, and rollout timing.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-socialmusic-001",
    "name": "SocialMusic",
    "role": "SOCIALMUSIC",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Plan music-specific platform content, teaser cadence, lyric hooks, behind-the-scenes concepts, and audience prompts.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-youtubemusic-001",
    "name": "YouTubeMusic",
    "role": "YOUTUBEMUSIC",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Optimize music video/visualizer/lyric-video packaging, playlists, descriptions, series structure, and channel SEO.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-streetteam-001",
    "name": "StreetTeam",
    "role": "STREETTEAM",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Plan grassroots sharing, community seeding, fan actions, QR/link assets, and measurable street-team missions.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-influencermusic-001",
    "name": "InfluencerMusic",
    "role": "INFLUENCERMUSIC",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Research creators whose audiences fit the release and prepare collaboration/outreach concepts.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-syncscout-001",
    "name": "SyncScout",
    "role": "SYNCSCOUT",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Research film, TV, creator, game, podcast, and licensing opportunities and their submission requirements.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-rightsdesk-001",
    "name": "RightsDesk",
    "role": "RIGHTSDESK",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Track composition/master ownership, samples, third-party material, permissions, registrations, and rights uncertainty.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "evidence-indexing"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-analyticsmusic-001",
    "name": "AnalyticsMusic",
    "role": "ANALYTICSMUSIC",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Measure release, channel, referral, playlist, content, and campaign performance across available data.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-fancrm-001",
    "name": "FanCRM",
    "role": "FANCRM",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Organize opt-in fan relationships, segments, engagement history, release interests, and follow-up opportunities.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-merchdesk-001",
    "name": "MerchDesk",
    "role": "MERCHDESK",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Develop merchandise concepts, margin/cost assumptions, bundles, release tie-ins, and vendor research.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-tourpromo-001",
    "name": "TourPromo",
    "role": "TOURPROMO",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Plan live-event/tour promotion, local media, venue/community outreach, geographic content, and show-day assets.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-archivemusic-001",
    "name": "ArchiveMusic",
    "role": "ARCHIVEMUSIC",
    "department": "Music",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Preserve masters, stems, lyric sheets, artwork, metadata, release files, source assets, and version history.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-video-chief-001",
    "name": "Video Chief",
    "role": "VIDEO_CHIEF",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-producer-001",
    "mission": "Run documentary, investigative, social, music-adjacent, and platform-video production with strict source provenance and approval-aware publishing.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-source-producer-001",
    "name": "Source Producer",
    "role": "SOURCE_PRODUCER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Find primary/original video, audio, document, and image sources and record the canonical URL and exact useful timecodes.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-source-archivist-001",
    "name": "Source Archivist",
    "role": "SOURCE_ARCHIVIST",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Maintain the permanent source manifest for every external clip, including canonical URL, source account/site, title, publication date, access date, timecodes, and rights notes.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-rights-checker-001",
    "name": "Rights Checker",
    "role": "RIGHTS_CHECKER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Review clip ownership, licensing terms, attribution, fair-use factors, uncertainty, and replacement options before publication.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-story-producer-001",
    "name": "Story Producer",
    "role": "STORY_PRODUCER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Shape evidence-backed video narratives, act structure, scene order, source needs, and reporting beats.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-documentarian-001",
    "name": "Documentarian",
    "role": "DOCUMENTARIAN",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Build documentary structure, narration, source sequence, interview/evidence integration, and fact-checked story flow.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-youtube-producer-001",
    "name": "YouTube Producer",
    "role": "YOUTUBE_PRODUCER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Package long-form YouTube videos for retention, chaptering, titles, descriptions, series consistency, and source disclosure.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-facebook-video-producer-001",
    "name": "Facebook Video Producer",
    "role": "FACEBOOK_VIDEO_PRODUCER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Adapt video packages for Facebook audience behavior, captions, aspect, hook timing, and context retention.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-clipper-001",
    "name": "Clipper",
    "role": "CLIPPER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Create short-form cut lists from approved footage with exact source/timecode references.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-highlight-editor-001",
    "name": "Highlight Editor",
    "role": "HIGHLIGHT_EDITOR",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Build highlight-reel structures and selects without detaching clips from their factual/source context.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-video-scriptwriter-001",
    "name": "Video Scriptwriter",
    "role": "VIDEO_SCRIPTWRITER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Write narration, intros, transitions, lower-third copy, and calls-to-action tied to verified material.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-fact-check-video-001",
    "name": "Fact Check Video",
    "role": "FACT_CHECK_VIDEO",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Verify spoken/onscreen claims, names, dates, quotations, and clip context before finalization.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-transcript-desk-001",
    "name": "Transcript Desk",
    "role": "TRANSCRIPT_DESK",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Create and clean transcripts, speaker labels, timecodes, searchable excerpts, and quote verification notes.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-thumbnail-lab-001",
    "name": "Thumbnail Lab",
    "role": "THUMBNAIL_LAB",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Develop thumbnail concepts and text variants that are compelling without misrepresenting the underlying reporting.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-title-lab-001",
    "name": "Title Lab",
    "role": "TITLE_LAB",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Develop title/headline variants balancing clarity, search intent, curiosity, and factual accuracy.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-visual-researcher-001",
    "name": "Visual Researcher",
    "role": "VISUAL_RESEARCHER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Find supporting public visuals, documents, maps, archival references, and contextual imagery with source records.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-graphics-producer-001",
    "name": "Graphics Producer",
    "role": "GRAPHICS_PRODUCER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Plan lower thirds, timelines, charts, maps, callouts, document highlights, and explainers.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-audio-post-001",
    "name": "Audio Post",
    "role": "AUDIO_POST",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Prepare audio-cleanup, dialogue-leveling, ducking, noise, transition, loudness, and delivery notes.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-music-supervisor-001",
    "name": "Music Supervisor",
    "role": "MUSIC_SUPERVISOR",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Select or brief music beds and cue placement while tracking ownership/licensing status.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-live-desk-001",
    "name": "Live Desk",
    "role": "LIVE_DESK",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Plan live-stream/run-of-show structure, source queue, fact checks, moderation, clipping, and post-live archive.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-video-publishing-desk-001",
    "name": "Video Publishing Desk",
    "role": "VIDEO_PUBLISHING_DESK",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Prepare approved upload packages, source credits, chapters, descriptions, links, captions, and platform metadata; actual publishing stays governed.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-video-seo-001",
    "name": "Video SEO",
    "role": "VIDEO_SEO",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Optimize topic targeting, titles, descriptions, chapters, captions, internal linking, and discoverability.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-video-analytics-001",
    "name": "Video Analytics",
    "role": "VIDEO_ANALYTICS",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Measure retention, click-through, watch time, source traffic, clip performance, and content experiments.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-archive-video-001",
    "name": "Archive Video",
    "role": "ARCHIVE_VIDEO",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Maintain final exports, project notes, transcript, source manifest, thumbnails, captions, and version history.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-platform-cutdown-001",
    "name": "Platform Cutdown",
    "role": "PLATFORM_CUTDOWN",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Translate long-form packages into platform-specific vertical/horizontal cutdown plans while preserving context.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-evidence-visualizer-001",
    "name": "Evidence Visualizer",
    "role": "EVIDENCE_VISUALIZER",
    "department": "Video",
    "tier": 2,
    "parentId": "apex-video-chief-001",
    "mission": "Convert timelines, filings, records, and quantitative evidence into clear, source-backed visual sequences.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "video-provenance",
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-webmaster-001",
    "name": "Webmaster",
    "role": "WEBMASTER",
    "department": "Websites",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Run the web portfolio across design, SEO, analytics, domain health, accessibility, conversion, and uptime.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "seo-audit",
      "regression-test"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-designer-001",
    "name": "Designer",
    "role": "DESIGNER",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Improve information architecture, visual hierarchy, responsive UI, component consistency, and conversion-oriented page design.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-seoengineer-001",
    "name": "SEOEngineer",
    "role": "SEOENGINEER",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Own technical SEO, crawl/indexation, rendering, schema, sitemaps, canonicals, speed, and search diagnostics.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "seo-audit",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-contentseo-001",
    "name": "ContentSEO",
    "role": "CONTENTSEO",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Align pages and editorial content with search intent, topical authority, internal linking, and useful on-page structure.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "seo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-analyticsweb-001",
    "name": "AnalyticsWeb",
    "role": "ANALYTICSWEB",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Define web analytics, funnel events, traffic-source reporting, page performance, and experiment measurement.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-domainmaster-001",
    "name": "DomainMaster",
    "role": "DOMAINMASTER",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Track domains, DNS intent, canonical hostnames, certificates, redirects, ownership, renewals, and environment mappings.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-accessibility-001",
    "name": "Accessibility",
    "role": "ACCESSIBILITY",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Audit semantics, keyboard navigation, labels, contrast, screen-reader structure, forms, focus, and WCAG-aligned issues.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-conversion-001",
    "name": "Conversion",
    "role": "CONVERSION",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Audit messaging, trust, calls-to-action, forms, friction, pricing paths, and conversion experiments.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-uptime-001",
    "name": "Uptime",
    "role": "UPTIME",
    "department": "Websites",
    "tier": 2,
    "parentId": "apex-webmaster-001",
    "mission": "Monitor health signals, render failures, availability, error patterns, and recovery evidence across public sites.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-apex-commander-001",
    "name": "APEX Commander",
    "role": "APEX_COMMANDER",
    "department": "APEX Command",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Run APEX as an autonomous revenue/work platform, coordinate reliability, model/provider routing, campaigns, CRM, voice, cost, product readiness, and release governance.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "cost-audit"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-mission-control-001",
    "name": "Mission Control",
    "role": "MISSION_CONTROL",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Continuously assess workforce health, queue movement, scheduler/worker liveness, campaign progress, incidents, and blockers.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human",
      "list_scheduled_tasks"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-agent-supervisor-001",
    "name": "Agent Supervisor",
    "role": "AGENT_SUPERVISOR",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Review agent status, repeated failures, stalled delegation, workload balance, and execution quality.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-orchestrator-auditor-001",
    "name": "Orchestrator Auditor",
    "role": "ORCHESTRATOR_AUDITOR",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Audit whether orchestration, delegation, scheduling, checkpoints, approvals, and work-generation paths behave as designed.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-llm-director-001",
    "name": "LLM Director",
    "role": "LLM_DIRECTOR",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Manage model-routing strategy, role fit, context/output budgets, fallback behavior, and model-quality evidence.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-provider-watch-001",
    "name": "Provider Watch",
    "role": "PROVIDER_WATCH",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Track provider availability, quota/rate-limit behavior, failure patterns, routing drift, and recovery evidence.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human",
      "list_scheduled_tasks"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-lead-engine-001",
    "name": "Lead Engine",
    "role": "LEAD_ENGINE",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Drive sourcing throughput, territory coverage, deduplication, enrichment, and qualified-lead persistence.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "searchBusinessDirectory",
      "saveResearchedLead",
      "saveResearchedLeadsBatch"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-research-engine-001",
    "name": "Research Engine",
    "role": "RESEARCH_ENGINE",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Coordinate multi-source business/account research and reusable intelligence artifacts.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "searchBusinessDirectory",
      "saveResearchedLead",
      "saveResearchedLeadsBatch"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-campaign-engine-001",
    "name": "Campaign Engine",
    "role": "CAMPAIGN_ENGINE",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Design and monitor bounded lead/email/call campaign workflows, segmentation, sequencing, and outcome reporting.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "make_outbound_call",
      "get_call_status",
      "send_email",
      "get_email_status",
      "start_email_campaign",
      "send_email_campaign_batch",
      "get_email_campaign_status",
      "campaign_snapshot",
      "add_email_suppression"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-outbound-engine-001",
    "name": "Outbound Engine",
    "role": "OUTBOUND_ENGINE",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Coordinate approved outbound email/phone execution, suppression/compliance controls, and truthful activity reporting.",
    "tools": [
      "listResearchedLeads",
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "make_outbound_call",
      "get_call_status",
      "send_email",
      "get_email_status",
      "start_email_campaign",
      "send_email_campaign_batch",
      "get_email_campaign_status",
      "campaign_snapshot",
      "add_email_suppression"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-voice-commander-001",
    "name": "Voice Commander",
    "role": "VOICE_COMMANDER",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Own outbound/inbound voice-agent reliability, call architecture, agent prompts, routing, and measurable sales/support outcomes.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-crm-commander-001",
    "name": "CRM Commander",
    "role": "CRM_COMMANDER",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Own pipeline data quality, stage definitions, next actions, deduplication, and campaign-to-opportunity continuity.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-conversion-lab-001",
    "name": "Conversion Lab",
    "role": "CONVERSION_LAB",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Analyze funnel conversion and design experiments from lead to meeting to close.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-revenue-ops-001",
    "name": "Revenue Ops",
    "role": "REVENUE_OPS",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Reconcile sourcing, outreach, pipeline, close, onboarding, and revenue metrics into one operating view.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-cost-governor-001",
    "name": "Cost Governor",
    "role": "COST_GOVERNOR",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Track model/provider/call/search/infrastructure spend, waste, retries, and cost per useful outcome.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-performance-engineer-apex-001",
    "name": "Performance Engineer APEX",
    "role": "PERFORMANCE_ENGINEER_APEX",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Profile throughput, latency, queue contention, timeouts, worker behavior, and scale bottlenecks.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-reliability-engineer-001",
    "name": "Reliability Engineer",
    "role": "RELIABILITY_ENGINEER",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Find recurring failure modes, missing recovery paths, stuck states, capacity pauses, and observability gaps.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-apex-qa-001",
    "name": "APEX QA",
    "role": "APEX_QA",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Test the APEX dashboard, APIs, worker paths, campaigns, approvals, settings, and critical operator flows.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-red-team-apex-001",
    "name": "Red Team APEX",
    "role": "RED_TEAM_APEX",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Adversarially test owned APEX surfaces for auth, data, injection, workflow, and unsafe-side-effect flaws without targeting third parties.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-release-commander-001",
    "name": "Release Commander",
    "role": "RELEASE_COMMANDER",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Prepare reviewed APEX release candidates, CI evidence, migration notes, rollback plan, and production verification checklist.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-telemetry-001",
    "name": "Telemetry",
    "role": "TELEMETRY",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Maintain operational telemetry definitions, attribution integrity, coverage gaps, and operator-facing diagnostics.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-data-steward-001",
    "name": "Data Steward",
    "role": "DATA_STEWARD",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Protect data definitions, lineage, retention assumptions, identifiers, deduplication, and privacy-minimized operational storage.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-security-apex-001",
    "name": "Security APEX",
    "role": "SECURITY_APEX",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Review owned APEX code/config for secure auth, secrets, permissions, dependencies, webhooks, and incident-hardening requirements.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-documentation-bot-001",
    "name": "Documentation Bot",
    "role": "DOCUMENTATION_BOT",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Keep architecture, operations, tools, routing, runbooks, and behavior documentation synchronized with source.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-product-strategist-001",
    "name": "Product Strategist",
    "role": "PRODUCT_STRATEGIST",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Turn operator problems, user needs, workflow gaps, and competitive context into prioritized product proposals.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-customer-simulation-001",
    "name": "Customer Simulation",
    "role": "CUSTOMER_SIMULATION",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Simulate realistic buyer/operator journeys to expose confusing behavior, unmet expectations, and product gaps.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-pilot-readiness-001",
    "name": "Pilot Readiness",
    "role": "PILOT_READINESS",
    "department": "APEX Command",
    "tier": 2,
    "parentId": "apex-apex-commander-001",
    "mission": "Evaluate whether features, onboarding, reliability, billing assumptions, support, metrics, and demos are ready for a paying pilot.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-bmb-commander-001",
    "name": "BMB Commander",
    "role": "BMB_COMMANDER",
    "department": "BuildMyBot",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Run BuildMyBot.App as a managed product: product health, engineering dispatch, voice/SMS, onboarding, support, analytics, release readiness, and truthful capability reporting.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-product-manager-001",
    "name": "Product Manager",
    "role": "PRODUCT_MANAGER",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own product priorities, acceptance criteria, roadmap, user value, dependencies, and shipped-vs-planned truth.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-ux-guardian-001",
    "name": "UX Guardian",
    "role": "UX_GUARDIAN",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Audit end-to-end product clarity, navigation, friction, feedback, forms, trust, and interaction consistency.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-onboarding-architect-001",
    "name": "Onboarding Architect",
    "role": "ONBOARDING_ARCHITECT",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Design the shortest reliable path from signup to a working bot/voice/SMS configuration.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-voice-experience-001",
    "name": "Voice Experience",
    "role": "VOICE_EXPERIENCE",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own conversation UX, latency expectations, interruption behavior, voice selection, scripts, escalation, and handoff experience.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-telnyx-engineer-001",
    "name": "Telnyx Engineer",
    "role": "TELNYX_ENGINEER",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own Telnyx call-control/media/number/configuration integration defects through managed engineering tickets.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-voice-qa-001",
    "name": "Voice QA",
    "role": "VOICE_QA",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Exercise voice setup, preview, inbound/outbound call paths, failure states, and quality acceptance criteria.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-sms-engineer-001",
    "name": "SMS Engineer",
    "role": "SMS_ENGINEER",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own registration, opt-in, sending, delivery, inbound/reply, status, compliance states, and SMS integration defects.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-knowledge-engineer-001",
    "name": "Knowledge Engineer",
    "role": "KNOWLEDGE_ENGINEER",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Improve knowledge-base ingestion, retrieval, source handling, chunking, freshness, and answer-grounding behavior.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-agent-designer-001",
    "name": "Agent Designer",
    "role": "AGENT_DESIGNER",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Design reliable customer-facing agent prompts, tool boundaries, handoff rules, persona, and conversation workflows.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-integration-engineer-bmb-001",
    "name": "Integration Engineer BMB",
    "role": "INTEGRATION_ENGINEER_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own external app/API/webhook integration requirements and engineering tickets for supported connectors.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-frontend-bmb-001",
    "name": "Frontend BMB",
    "role": "FRONTEND_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own BuildMyBot dashboard/landing/wizard UI defects and enhancements through repository-scoped engineering tickets.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-backend-bmb-001",
    "name": "Backend BMB",
    "role": "BACKEND_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own BuildMyBot server/API/business-logic defects and enhancements through repository-scoped engineering tickets.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-database-bmb-001",
    "name": "Database BMB",
    "role": "DATABASE_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own BuildMyBot schema, integrity, query, migration, persistence, and data-model defects through managed engineering.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-auth-guardian-001",
    "name": "Auth Guardian",
    "role": "AUTH_GUARDIAN",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Own signup/signin/session/OAuth/access-control reliability and security acceptance criteria.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-billing-bot-001",
    "name": "Billing Bot",
    "role": "BILLING_BOT",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Audit plans, checkout, entitlements, usage/overage, invoices, test-vs-live billing truth, and billing defects.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-activation-qa-001",
    "name": "Activation QA",
    "role": "ACTIVATION_QA",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Verify a new tenant can complete setup, activate, and reach first value without hidden blockers.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-regression-bot-001",
    "name": "Regression Bot",
    "role": "REGRESSION_BOT",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Run targeted regression planning after changes across core signup, wizard, bot, voice, SMS, KB, and billing paths.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-bug-hunter-bmb-001",
    "name": "Bug Hunter BMB",
    "role": "BUG_HUNTER_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Reproduce customer-visible defects, isolate likely root cause, and dispatch evidence-rich engineering tickets.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-customer-simulator-bmb-001",
    "name": "Customer Simulator BMB",
    "role": "CUSTOMER_SIMULATOR_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Simulate novice, SMB owner, technical buyer, support agent, and power-user journeys against observed product behavior.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-accessibility-qa-bmb-001",
    "name": "Accessibility QA BMB",
    "role": "ACCESSIBILITY_QA_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Audit BuildMyBot accessibility and dispatch concrete defects with reproducible evidence.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-performance-bmb-001",
    "name": "Performance BMB",
    "role": "PERFORMANCE_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Measure and improve latency, rendering, server response, voice timing, resource use, and bottlenecks through managed engineering.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-reliability-bmb-001",
    "name": "Reliability BMB",
    "role": "RELIABILITY_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Find recurring errors, silent failures, missing recovery, queue/job issues, and availability risks.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-security-bmb-001",
    "name": "Security BMB",
    "role": "SECURITY_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Review BuildMyBot-owned auth, input, secrets, dependencies, data boundaries, and platform security defects.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-release-manager-bmb-001",
    "name": "Release Manager BMB",
    "role": "RELEASE_MANAGER_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Prepare release readiness, CI evidence, regression scope, changelog, rollback notes, deployment approval, and health verification.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering",
      "buildmybot_deploy"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-incident-commander-001",
    "name": "Incident Commander",
    "role": "INCIDENT_COMMANDER",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Coordinate current production incidents using health/error evidence, corrective briefing, engineering dispatch, recovery verification, and postmortem.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human",
      "buildmybot_dispatch_engineering",
      "buildmybot_deploy"
    ],
    "skills": [
      "source-verification",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-analytics-bmb-001",
    "name": "Analytics BMB",
    "role": "ANALYTICS_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Define product KPIs, adoption, activation, retention, feature use, support demand, and funnel reporting from available telemetry.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-feedback-analyst-001",
    "name": "Feedback Analyst",
    "role": "FEEDBACK_ANALYST",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Synthesize customer/support/QA feedback into recurring themes, severity, evidence, and prioritized product changes.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-help-center-001",
    "name": "Help Center",
    "role": "HELP_CENTER",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Create and maintain accurate help articles, setup guides, troubleshooting flows, and FAQs based only on verified features.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-support-agent-001",
    "name": "Support Agent",
    "role": "SUPPORT_AGENT",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Triage customer questions and incidents against real product status; never promise unverified capability.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-changelog-001",
    "name": "Changelog",
    "role": "CHANGELOG",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Create accurate release notes from merged/shipped evidence rather than planned work.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-competitive-intel-bmb-001",
    "name": "Competitive Intel BMB",
    "role": "COMPETITIVE_INTEL_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Research competing AI chatbot/voice/SMS products, packaging, positioning, capabilities, and buyer objections with sources.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-product-scout-bmb-001",
    "name": "Product Scout BMB",
    "role": "PRODUCT_SCOUT_BMB",
    "department": "BuildMyBot",
    "tier": 2,
    "parentId": "apex-bmb-commander-001",
    "mission": "Find new product patterns, integrations, UX ideas, and market opportunities worth testing.",
    "tools": [
      "buildmybot_status",
      "buildmybot_open_errors",
      "buildmybot_health_check",
      "readFile",
      "writeFile",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-portfolio-commander-001",
    "name": "Portfolio Commander",
    "role": "PORTFOLIO_COMMANDER",
    "department": "Portfolio",
    "tier": 1,
    "parentId": "apex-ceo-001",
    "mission": "Coordinate cross-project priorities, standards, reusable capabilities, dependencies, and executive portfolio review.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "webSearch",
      "fetchUrl",
      "requestPeerReview",
      "sendMessage",
      "get_delegation_status",
      "get_task_details",
      "health_check",
      "escalate_to_human"
    ],
    "skills": [
      "morning-executive-brief",
      "cost-audit"
    ],
    "activationMode": "standing",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-technology-scout-001",
    "name": "Technology Scout",
    "role": "TECHNOLOGY_SCOUT",
    "department": "Portfolio",
    "tier": 2,
    "parentId": "apex-portfolio-commander-001",
    "mission": "Evaluate emerging models, providers, libraries, infrastructure, APIs, and tools for concrete portfolio use cases.",
    "tools": [
      "webSearch",
      "fetchUrl",
      "readFile",
      "writeFile",
      "requestPeerReview",
      "sendMessage",
      "escalate_to_human"
    ],
    "skills": [
      "source-verification",
      "cost-audit"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-standards-architect-001",
    "name": "Standards Architect",
    "role": "STANDARDS_ARCHITECT",
    "department": "Portfolio",
    "tier": 2,
    "parentId": "apex-portfolio-commander-001",
    "mission": "Maintain cross-project engineering, documentation, observability, release, security, and UX standards without forcing inappropriate uniformity.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "apex-repo-audit",
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  },
  {
    "id": "apex-portfolio-breakers-001",
    "name": "Portfolio Breakers",
    "role": "PORTFOLIO_BREAKERS",
    "department": "Portfolio",
    "tier": 2,
    "parentId": "apex-portfolio-commander-001",
    "mission": "Run non-destructive black-box and workflow QA across owned products and sites; turn failures into reproducible evidence and routed fixes.",
    "tools": [
      "readFile",
      "writeFile",
      "listDir",
      "runInSandbox",
      "create_pull_request",
      "requestPeerReview",
      "sendMessage",
      "health_check",
      "browserCheck",
      "get_delegation_status",
      "get_task_details",
      "escalate_to_human"
    ],
    "skills": [
      "regression-test"
    ],
    "activationMode": "on_demand",
    "maxIterations": 24,
    "approvalRequired": false
  }
];

function directReportsFor(agentId: string): Array<{ id: string; name: string }> {
  const portfolio = PORTFOLIO_AGENT_DEFINITIONS
    .filter((definition) => definition.parentId === agentId)
    .map(({ id, name }) => ({ id, name }));
  const existing = EXISTING_AGENT_ALIASES
    .filter((definition) => definition.parentId === agentId)
    .map(({ id, name }) => ({ id, name }));
  return [...portfolio, ...existing];
}

function buildSystemPrompt(definition: PortfolioAgentDefinition): string {
  const reports = directReportsFor(definition.id);
  const reportText = reports.length
    ? reports.map((report) => `- ${report.name}: ${report.id}`).join('\n')
    : '- No standing direct reports. Execute the work yourself or escalate/delegate only when a real recipient is known.';

  return `You are ${definition.name}, the ${definition.department} specialist in the APEX portfolio workforce.

## Mission
${definition.mission}

## Reporting line
You report to: ${definition.parentId ?? 'Atlas / human operator'}.

## Direct reports
${reportText}

## Shared skills
${renderPortfolioSkills(definition.skills)}

## Operating contract
1. Verify before claiming. Use available tools and cite/source the material you relied on in the work product.
2. Never invent success, source material, customer activity, metrics, legal authority, deployment evidence, or external side effects.
3. Preserve provenance. If a task involves third-party video/audio/images, keep the original/canonical URL and exact timecode plus the source/date/rights notes required by the Video Provenance skill.
4. Delegation is not completion. Follow delegated work to a real result before reporting it as delivered.
5. Keep reversible internal research, drafting, analysis, repository inspection, and branch work moving autonomously when allowed.
6. Respect APEX governance. Publishing, real outbound communications/calls, spending, destructive operations, production deployment/rollback, filings, and agreements remain subject to the existing human-approval policy. Never work around a hard gate.
7. Use exact agent IDs shown above when delegating. Never delegate to yourself.
8. AEGIS is not part of the active roster and must not be invented or routed work.
`;
}

export class PortfolioAgent extends BaseAgent {
  readonly activationMode: PortfolioActivationMode;
  readonly department: string;

  constructor(
    readonly definition: PortfolioAgentDefinition,
    overrides: Partial<AgentConfig> = {},
  ) {
    const runtimeRole = definition.role as AgentRole;
    super({
      id: definition.id,
      name: definition.name,
      role: runtimeRole,
      tier: definition.tier,
      parentId: definition.parentId ?? undefined,
      systemPrompt: buildSystemPrompt(definition),
      llm: getDefaultLLMConfig(definition.role),
      tools: definition.tools,
      maxIterations: definition.maxIterations,
      approvalRequired: definition.approvalRequired,
      ...overrides,
    });
    this.activationMode = definition.activationMode;
    this.department = definition.department;
  }
}

export function createPortfolioWorkforce(
  options: { approvalRequired?: boolean } = {},
): Map<string, PortfolioAgent> {
  const workforce = new Map<string, PortfolioAgent>();
  for (const definition of PORTFOLIO_AGENT_DEFINITIONS) {
    const overrides: Partial<AgentConfig> = {};
    if (options.approvalRequired !== undefined) overrides.approvalRequired = options.approvalRequired;
    const agent = new PortfolioAgent(definition, overrides);
    if (workforce.has(agent.id)) throw new Error(`Duplicate portfolio agent id: ${agent.id}`);
    workforce.set(agent.id, agent);
  }
  return workforce;
}

export function isPortfolioAgent(agent: BaseAgent): agent is PortfolioAgent {
  return agent instanceof PortfolioAgent;
}

export function isOnDemandPortfolioAgent(agent: BaseAgent): agent is PortfolioAgent {
  return isPortfolioAgent(agent) && agent.activationMode === 'on_demand';
}

export function isStandingPortfolioAgent(agent: BaseAgent): agent is PortfolioAgent {
  return isPortfolioAgent(agent) && agent.activationMode === 'standing';
}

export function assertPortfolioRoster(): void {
  const ids = new Set<string>();
  const existingIds = new Set(EXISTING_AGENT_ALIASES.map((alias) => alias.id));
  for (const definition of PORTFOLIO_AGENT_DEFINITIONS) {
    if (ids.has(definition.id) || existingIds.has(definition.id)) {
      throw new Error(`Duplicate workforce agent id: ${definition.id}`);
    }
    ids.add(definition.id);
    const searchable = `${definition.id} ${definition.name} ${definition.role}`.toLowerCase();
    if (searchable.includes('aegis')) throw new Error('AEGIS is intentionally excluded from this roster');
    if (!definition.tools.length) throw new Error(`Agent ${definition.id} has no real tool allowlist`);
  }
}

assertPortfolioRoster();
