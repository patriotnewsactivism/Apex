import { z } from 'zod';

// Campaign creation never asks for a spend amount or a mode. Every campaign
// runs on existing resources; the global hard caps (APEX_DAILY_SPEND_USD and
// per-key limits) are enforced server-side, not chosen by the operator.
export const createCampaignSchema = z
  .object({
    name: z.string().min(3).max(120),
    industries: z.array(z.string().min(1)).min(1).max(20),
    // Explicit cities remain supported and combine with states/national
    // below rather than being replaced by them.
    cities: z.array(z.string().min(1)).max(50).optional().default([]),
    // Two-letter USPS codes — each expands to that state's principal cities.
    states: z.array(z.string().min(2).max(2)).max(51).optional(),
    // Shorthand for every state at once.
    national: z.boolean().optional().default(false),
    targetLeads: z.number().int().min(1).max(5000).optional().default(100),
    goalId: z.string().optional(),
    projectId: z.string().optional(),
    pushToBuildmybot: z.boolean().optional().default(false),
    notes: z.string().max(2000).optional(),
  })
  .refine(
    (v) => v.cities.length > 0 || (v.states?.length ?? 0) > 0 || v.national,
    { message: 'Provide at least one city, one state, or national=true.', path: ['cities'] },
  );

export function campaignValidationErrorBody(error: z.ZodError): {
  error: string;
  details: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
} {
  const details = error.flatten();
  return { error: 'Invalid campaign request', details };
}
