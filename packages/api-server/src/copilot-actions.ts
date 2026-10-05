import { z } from "zod";

export const COPILOT_SERVER_FLAG = "FEATURE_COPILOT";

export const COPILOT_SAFE_PAGES = [
  "command",
  "chat",
  "mission",
  "agents",
  "tasks",
  "leads",
  "contacts",
  "territories",
  "webinars",
  "artifacts",
  "scheduled",
  "suggestions",
  "logs",
  "health",
  "learning",
  "multiapp",
  "verify-scale",
] as const;

const copilotSafePageSchema = z.enum(COPILOT_SAFE_PAGES);

const navigateActionSchema = z
  .object({
    type: z.literal("navigate"),
    page: copilotSafePageSchema,
  })
  .strict();

const searchActionSchema = z
  .object({
    type: z.literal("search"),
    page: z.enum(["leads", "contacts"]),
    query: z.string().trim().min(1).max(200),
  })
  .strict();

const setFilterActionSchema = z
  .object({
    type: z.literal("setFilter"),
    page: z.enum(["leads", "contacts"]),
    field: z.string().trim().min(1).max(64),
    value: z.union([z.string().max(200), z.boolean(), z.null()]),
  })
  .strict();

const openRecordActionSchema = z
  .object({
    type: z.literal("openRecord"),
    recordType: z.enum(["lead", "contact"]),
    id: z.string().uuid(),
  })
  .strict();

export const copilotActionSchema = z.discriminatedUnion("type", [
  navigateActionSchema,
  searchActionSchema,
  setFilterActionSchema,
  openRecordActionSchema,
]);

export type CopilotAction = z.infer<typeof copilotActionSchema>;

const CONTACT_FILTERS = new Set([
  "q",
  "tag",
  "city",
  "state",
  "verifiedOnly",
  "ownerBot",
  "replied",
  "campaignId",
]);
const LEAD_FILTERS = new Set(["status", "pipelineState", "industry"]);

/**
 * Names and concepts that Apex Copilot must never execute. The public
 * registry is allow-list based, but this explicit list makes policy failures
 * distinguishable from malformed/unknown action names and keeps regression
 * tests tied to the product's safety contract.
 */
export const COPILOT_HARD_DENY_ACTIONS = [
  "send",
  "sendEmail",
  "sendSms",
  "sendInvite",
  "makeOutboundCall",
  "releaseSend",
  "confirm",
  "confirmApproval",
  "enterCode",
  "setKillSwitch",
  "setOutboundPolicy",
  "readSecret",
  "writeSecret",
  "changeBilling",
  "makePayment",
  "delete",
  "deleteRecord",
  "deploy",
  "rollback",
  "mergeContacts",
  "changeUser",
  "changePermission",
] as const;

const DENIED_TOKENS = [
  "send",
  "invite",
  "call",
  "release",
  "confirm",
  "approval",
  "code",
  "killswitch",
  "outboundpolicy",
  "secret",
  "apikey",
  "billing",
  "payment",
  "delete",
  "deploy",
  "rollback",
  "merge",
  "user",
  "permission",
] as const;

export type CopilotActionValidation =
  | { ok: true; action: CopilotAction }
  | {
      ok: false;
      code: "denied" | "invalid" | "not_allowed";
      reason: string;
      actionType?: string;
    };

export function isCopilotFeatureEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[COPILOT_SERVER_FLAG]?.trim().toLowerCase() === "true";
}

function compactActionName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isHardDeniedCopilotAction(actionType: string): boolean {
  const compact = compactActionName(actionType);
  return DENIED_TOKENS.some((token) => compact.includes(token));
}

export function validateCopilotAction(input: unknown): CopilotActionValidation {
  const actionType =
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    typeof input.type === "string"
      ? input.type
      : undefined;

  if (actionType && isHardDeniedCopilotAction(actionType)) {
    return {
      ok: false,
      code: "denied",
      reason: `"${actionType}" is blocked by the Apex Copilot hard deny policy.`,
      actionType,
    };
  }

  const parsed = copilotActionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: actionType ? "not_allowed" : "invalid",
      reason: actionType
        ? `"${actionType}" is not in the Apex Copilot action registry.`
        : "Apex Copilot actions require a valid action type and arguments.",
      actionType,
    };
  }

  if (parsed.data.type === "setFilter") {
    const allowed =
      parsed.data.page === "contacts"
        ? CONTACT_FILTERS.has(parsed.data.field)
        : LEAD_FILTERS.has(parsed.data.field);
    if (!allowed) {
      return {
        ok: false,
        code: "not_allowed",
        reason: `Filter "${parsed.data.field}" is not allowed on ${parsed.data.page}.`,
        actionType: parsed.data.type,
      };
    }
  }

  return { ok: true, action: parsed.data };
}

export function validateCopilotActions(input: unknown): {
  actions: CopilotAction[];
  rejected: Array<Exclude<CopilotActionValidation, { ok: true }>>;
} {
  if (!Array.isArray(input)) {
    return {
      actions: [],
      rejected: [
        {
          ok: false,
          code: "invalid",
          reason: "Apex Copilot requires an actions array.",
        },
      ],
    };
  }

  const actions: CopilotAction[] = [];
  const rejected: Array<Exclude<CopilotActionValidation, { ok: true }>> = [];
  for (const candidate of input.slice(0, 10)) {
    const result = validateCopilotAction(candidate);
    if (result.ok) actions.push(result.action);
    else rejected.push(result);
  }
  return { actions, rejected };
}
