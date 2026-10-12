import { describe, expect, it } from 'vitest';
import {
  renderSalesAgentConstitution,
  SALES_AGENT_CONSTITUTION_PLACEHOLDERS,
  SALES_AGENT_CONSTITUTION_TEMPLATE,
} from '../sales-agent-constitution.js';

/**
 * The constitution is the shared protocol every APEX sales agent follows; only
 * the spoken name differs. These checks exist because both failure modes are
 * invisible until a live call is already happening: an unsubstituted
 * `{{agent_name}}` is read aloud to a prospect, and a baked-in personal name
 * makes the protocol wrong for every agent but one.
 */
describe('sales agent constitution', () => {
  it('contains only the two known placeholders', () => {
    const braces = new Set(SALES_AGENT_CONSTITUTION_TEMPLATE.match(/\{\{[^}]*\}\}/g) ?? []);
    for (const placeholder of braces) {
      expect(SALES_AGENT_CONSTITUTION_PLACEHOLDERS).toContain(placeholder);
    }
    // Every allowed slot must actually be exercised by the text.
    for (const placeholder of SALES_AGENT_CONSTITUTION_PLACEHOLDERS) {
      expect(SALES_AGENT_CONSTITUTION_TEMPLATE).toContain(placeholder);
    }
  });

  it('bakes in no personal name of its own', () => {
    expect(SALES_AGENT_CONSTITUTION_TEMPLATE).not.toMatch(/\bDan\b/i);
  });

  it('substitutes both registers of the name', () => {
    const rendered = renderSalesAgentConstitution('Riley');
    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('this is Riley');
    expect(rendered).toContain("RILEY'S PROFESSIONAL PERSONALITY");
  });

  it('renders the same protocol whatever the name is', () => {
    const neutralise = (text: string, name: string) =>
      text.replaceAll(name, '#').replaceAll(name.toUpperCase(), '#');
    expect(neutralise(renderSalesAgentConstitution('Dan'), 'Dan')).toBe(
      neutralise(renderSalesAgentConstitution('Riley'), 'Riley'),
    );
  });

  it('refuses an empty name rather than shipping a blank agent', () => {
    expect(() => renderSalesAgentConstitution('   ')).toThrow(/non-empty agent name/);
  });
});
