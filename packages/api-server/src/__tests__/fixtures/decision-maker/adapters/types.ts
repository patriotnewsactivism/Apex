import type { LeadCase } from '../cases.js';

export interface LeadDecision {
  /** Would this lead auto-move to the contact-ready set? */
  contactReady: boolean;
  decisionMaker: { name: string; title: string | null; sourceUrl: string | null } | null;
  stage: string;
}

export interface CacheRow {
  city: string;
  campaignDraft: Record<string, unknown>;
  contactResearch: { contactPhone?: string; contactEmail?: string };
  verification: { status: string; checkedAt: string };
}

/** One implementation under test: origin/main's logic or the branch's. */
export interface Impl {
  name: 'main' | 'branch';
  evaluateLead(c: LeadCase): Promise<LeadDecision>;
  titleQualifies(title: string): boolean;
  replaceCompanyNameText(value: string, oldName: string, newName: string): string;
  phoneFlaggedFake(phone: string): boolean;
  cacheRowReadyForNewCity(row: CacheRow, inputCity: string, now: Date): boolean;
}

export const SUITE_NOW = new Date('2026-10-03T20:00:00.000Z');
