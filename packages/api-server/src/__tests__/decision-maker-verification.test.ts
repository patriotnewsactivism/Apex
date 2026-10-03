/**
 * Bad-match detection suite for decision-maker verification (see
 * fixtures/decision-maker/TESTS.md for what each case catches).
 *
 * Core rule: a lead may auto-move to contact-ready ONLY when a named decision
 * maker with a qualifying title is verified on a first-party page (same
 * registrable domain, name and title visible on that page) or on a confirmed
 * source, with the source URL recorded. Every lead case asserts that rule
 * plus the human ground truth for the fixture.
 *
 * Target selection (no database, no network; fixtures are served from disk):
 *   default                 the branch's logic
 *   DM_SUITE_TARGET=main    origin/main's logic from an unmodified worktree at
 *                           DM_SUITE_MAIN_ROOT (default /workspace/apex-llm/baseline-wt)
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CNN_CACHE_ROW, LEAD_CASES, TITLE_CASES, type LeadCase } from './fixtures/decision-maker/cases.js';
import { fixturePage } from './fixtures/decision-maker/adapters/server.js';
import { SUITE_NOW, type Impl, type LeadDecision } from './fixtures/decision-maker/adapters/types.js';
import { branchImpl } from './fixtures/decision-maker/adapters/branch.js';

const TARGET = process.env.DM_SUITE_TARGET === 'main' ? 'main' : 'branch';

async function loadImpl(): Promise<Impl> {
  if (TARGET === 'branch') return branchImpl;
  const main = await import('./fixtures/decision-maker/adapters/main.js');
  if (!existsSync(main.MAIN_ROOT)) throw new Error(`DM_SUITE_MAIN_ROOT not found: ${main.MAIN_ROOT}`);
  main.assertCopiedFromMain();
  return main.mainImpl;
}
const impl = await loadImpl();

// Independent helpers (deliberately not the code under test).
const registrable = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().split('.').slice(-2).join('.'); } catch { return null; }
};
const visibleText = (html: string): string => html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

/** The rule every lead must satisfy; returns the violations instead of throwing so messages are specific. */
function autoMoveViolations(c: LeadCase, d: LeadDecision): string[] {
  const out: string[] = [];
  if (!d.contactReady) return out;
  const dm = d.decisionMaker;
  if (!dm?.name) return ['contact-ready without a named decision maker'];
  if (!dm.title) out.push('contact-ready without the decision maker\'s title');
  if (!dm.sourceUrl) return [...out, 'contact-ready without a recorded source URL'];
  const firstParty = registrable(dm.sourceUrl) === registrable(c.lead.website);
  if (firstParty) {
    const page = fixturePage(c, dm.sourceUrl);
    if (!page) out.push(`source page ${dm.sourceUrl} is not a known first-party page`);
    else {
      const text = visibleText(page);
      if (!text.includes(dm.name)) out.push(`"${dm.name}" is not visible on ${dm.sourceUrl}`);
      if (dm.title && !text.toLowerCase().includes(dm.title.toLowerCase())) out.push(`title "${dm.title}" is not visible on ${dm.sourceUrl}`);
    }
  } else if (!(c.confirmedSources ?? []).includes(dm.sourceUrl)) {
    out.push(`source ${dm.sourceUrl} is third-party and not confirmed`);
  }
  return out;
}

describe(`decision-maker bad-match detection [${TARGET}]`, () => {
  describe('lead fixtures: no auto-move to contact-ready without a verified name + role and source URL', () => {
    for (const c of LEAD_CASES) {
      it(`${c.id}`, async () => {
        const d = await impl.evaluateLead(c);
        const ctx = `${c.id} (${d.stage}) dm=${d.decisionMaker ? `${d.decisionMaker.name} / ${d.decisionMaker.title} @ ${d.decisionMaker.sourceUrl}` : 'none'}`;
        expect(autoMoveViolations(c, d), ctx).toEqual([]);
        expect(d.contactReady, `${ctx}: contact-ready`).toBe(c.expect.contactReady);
        if (c.expect.decisionMaker) {
          expect(d.decisionMaker?.name, ctx).toBe(c.expect.decisionMaker);
          expect(d.decisionMaker?.title ?? '', ctx).toMatch(c.expect.title ?? /./);
        }
      });
    }
  });

  describe('title authority rules (owner / VP / director / real authority pass; staff fail)', () => {
    for (const t of TITLE_CASES) {
      it(`${t.qualifies ? 'accepts' : 'rejects'} "${t.title}"`, () => {
        expect(impl.titleQualifies(t.title)).toBe(t.qualifies);
      });
    }
  });

  it('la_city_law_vanity_number: 888-880-8888 is a real toll-free vanity number and is NOT flagged fake', () => {
    expect(impl.phoneFlaggedFake('+18888808888')).toBe(false);
    expect(impl.phoneFlaggedFake('(888) 880-8888')).toBe(false);
  });

  it('indianapolis_whole_word_replace: renaming "Indiana" never edits "Indianapolis"', () => {
    const out = impl.replaceCompanyNameText('Help Indiana reach readers across Indianapolis, IN.', 'Indiana', 'Hannah News Service');
    expect(out).toBe('Help Hannah News Service reach readers across Indianapolis, IN.');
    expect(out).not.toContain('Servicepolis');
  });

  it('cnn_cache_copy_reno_atlanta: a cached Atlanta row is not reused to mark a Reno lead ready without a re-check', () => {
    expect(impl.cacheRowReadyForNewCity(CNN_CACHE_ROW, 'Reno, NV', SUITE_NOW)).toBe(false);
  });
});
