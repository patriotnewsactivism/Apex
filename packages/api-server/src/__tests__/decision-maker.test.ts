import { describe, expect, it } from 'vitest';
import {
  canonicalDecisionMakerTitle,
  extractDecisionMaker,
  isPlausiblePersonName,
} from '../../../core/src/decision-maker.js';

/**
 * The operator's requirement is a NAMED person to call: an email alone cannot
 * open a calling campaign, so the pipeline must find decision makers rather than
 * treat an address as the job being done.
 *
 * The old extraction took the first non-navigation line of the page text, which
 * meant taglines and address fragments were stored as people. A wrong human on a
 * lead is worse than an empty field — a campaign dials them and reads the wrong
 * name out loud — so half of these cases are refusals.
 */
describe('decision maker extraction', () => {
  it('reads a name and title written together', () => {
    expect(extractDecisionMaker('Dana Whitfield, Owner')).toEqual({ name: 'Dana Whitfield', title: 'owner' });
    expect(extractDecisionMaker('Owner: Dana Whitfield')).toEqual({ name: 'Dana Whitfield', title: 'owner' });
    expect(extractDecisionMaker('Dana Whitfield — Owner')).toEqual({ name: 'Dana Whitfield', title: 'owner' });
  });

  it('reads the team-card layout where name and title are on separate lines', () => {
    expect(extractDecisionMaker('Our Team\nDana Whitfield\nOwner\nCall us today'))
      .toEqual({ name: 'Dana Whitfield', title: 'owner' });
    expect(extractDecisionMaker('Owner\nDana Whitfield\n555-0100'))
      .toEqual({ name: 'Dana Whitfield', title: 'owner' });
  });

  it('prefers the most senior person on the page', () => {
    expect(extractDecisionMaker('Bob Lee, General Manager\nDana Whitfield, Owner'))
      .toEqual({ name: 'Dana Whitfield', title: 'owner' });
  });

  it('accepts any decision maker, not only the owner', () => {
    expect(extractDecisionMaker('Bob Lee, Office Manager'))
      .toEqual({ name: 'Bob Lee', title: 'office manager' });
  });

  it('handles a middle initial without splitting the name', () => {
    expect(extractDecisionMaker('Dana R. Whitfield, President'))
      .toEqual({ name: 'Dana R. Whitfield', title: 'president' });
  });

  it('refuses the junk the old heuristic stored as a person', () => {
    expect(extractDecisionMaker('Solid Wood, Trusted Since 1998')).toBeNull();
    expect(extractDecisionMaker('Quality Roofing, Owner')).toBeNull();
    expect(extractDecisionMaker('Welcome to Our Site\nWe offer the best service')).toBeNull();
    expect(extractDecisionMaker('Dana Whitfield\nWe serve the greater Houston area\nOwner financing available')).toBeNull();
    expect(extractDecisionMaker('')).toBeNull();
  });

  it('validates person names', () => {
    for (const name of ['Dana Whitfield', 'Dana R. Whitfield', "Dana O'Brien", 'Dana Rae']) {
      expect(isPlausiblePersonName(name), name).toBe(true);
    }
    for (const notName of ['Dana', 'Owner Smith', 'The Team', 'Dana Whitfield Smith Jones']) {
      expect(isPlausiblePersonName(notName), notName).toBe(false);
    }
  });

  it('canonicalises titles so the longest match wins', () => {
    expect(canonicalDecisionMakerTitle('General Manager')).toBe('general manager');
    expect(canonicalDecisionMakerTitle('Owner')).toBe('owner');
    expect(canonicalDecisionMakerTitle('Chief Executive Officer')).toBe('chief executive officer');
    expect(canonicalDecisionMakerTitle('Head of Widgets')).toBeNull();
  });
});
