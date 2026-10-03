import { describe, expect, it } from 'vitest';
import { BUILD_MY_BOT_INTRO, renderPlaybookTemplate } from '@workspace/core';

// The playbook's call.firstMessage is not the call greeting. The Cartesia agent
// greets, confirms identity, does the first-name rapport + empathy step, and
// only then says this line as {{campaign_first_message}} ("Reason-for-call
// line"). These tests pin that contract; the CI guard
// scripts/verify-cartesia-canonical-sales-routing.ts checks the same copy.
describe('BuildMyBot call reason-for-call line', () => {
  const fields = {
    buyerName: 'Maria Lopez',
    companyName: 'Lakeshore Plumbing',
    industry: 'plumbing',
    city: 'Chicago',
  };
  const line = renderPlaybookTemplate(BUILD_MY_BOT_INTRO.call.firstMessage, fields);

  it('renders with no missing fields', () => {
    expect(line.missing).toEqual([]);
    expect(line.text).toBe(
      'We help businesses like Lakeshore Plumbing catch missed calls before they turn into lost jobs. When a call comes in and nobody can answer, what happens to it?',
    );
  });

  it('fits the live "one or two spoken sentences per turn" rule and ends on the missed-call question', () => {
    const sentences = line.text.match(/[^.?!]+[.?!]/g) ?? [];
    expect(sentences.length).toBeLessThanOrEqual(2);
    expect(line.text.trim().endsWith('?')).toBe(true);
    expect(line.text).toMatch(/nobody can answer/);
  });

  it('does not re-greet or re-name the callee, because rapport already happened', () => {
    expect(BUILD_MY_BOT_INTRO.call.firstMessage).not.toContain('{{buyerName}}');
    expect(line.text).not.toContain('Maria');
    expect(line.text).not.toMatch(/\b(hi|hello|hey)\b|how(’|')?s your day/i);
  });

  it('keeps the first-name rapport and empathy step before the pitch in the assistant prompt', () => {
    const prompt = BUILD_MY_BOT_INTRO.call.assistantPrompt;
    const rapport = prompt.indexOf('acknowledge them by first name once, ask how their day is going');
    const empathy = prompt.indexOf('brief empathetic response before moving into the reason for the call');
    expect(rapport).toBeGreaterThan(-1);
    expect(empathy).toBeGreaterThan(rapport);
    expect(prompt).toContain('Speak English only');
    expect(BUILD_MY_BOT_INTRO.version).toBeGreaterThanOrEqual(6);
  });
});
