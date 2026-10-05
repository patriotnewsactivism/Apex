import { describe, expect, it } from "vitest";
import {
  COPILOT_HARD_DENY_ACTIONS,
  isCopilotFeatureEnabled,
  validateCopilotAction,
} from "../copilot-actions.js";
import { isCopilotClientFeatureEnabled } from "../../../dashboard/src/copilot/feature-flag.js";

describe("Apex Copilot feature flag", () => {
  it("is off by default and accepts only an explicit true value", () => {
    expect(isCopilotFeatureEnabled({})).toBe(false);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: "false" })).toBe(false);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: "1" })).toBe(false);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: "true" })).toBe(true);
    expect(isCopilotFeatureEnabled({ FEATURE_COPILOT: " TRUE " })).toBe(true);
  });

  it("keeps the dashboard toggle hidden unless the Vite flag is explicitly true", () => {
    expect(isCopilotClientFeatureEnabled(undefined)).toBe(false);
    expect(isCopilotClientFeatureEnabled("false")).toBe(false);
    expect(isCopilotClientFeatureEnabled("1")).toBe(false);
    expect(isCopilotClientFeatureEnabled("true")).toBe(true);
  });
});

describe("Apex Copilot action registry", () => {
  it("accepts only the scoped dashboard actions", () => {
    expect(
      validateCopilotAction({ type: "navigate", page: "contacts" }),
    ).toEqual({
      ok: true,
      action: { type: "navigate", page: "contacts" },
    });
    expect(
      validateCopilotAction({
        type: "setFilter",
        page: "leads",
        field: "status",
        value: "qualified",
      }).ok,
    ).toBe(true);
    expect(
      validateCopilotAction({
        type: "setFilter",
        page: "contacts",
        field: "doNotContact",
        value: true,
      }).ok,
    ).toBe(false);
  });

  it.each(COPILOT_HARD_DENY_ACTIONS)("hard-denies %s", (type) => {
    const result = validateCopilotAction({ type });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("denied");
  });

  it("rejects unknown and sensitive destinations", () => {
    expect(
      validateCopilotAction({ type: "click", selector: "#anything" }).ok,
    ).toBe(false);
    expect(
      validateCopilotAction({ type: "navigate", page: "settings" }).ok,
    ).toBe(false);
    expect(
      validateCopilotAction({ type: "navigate", page: "pending-sends" }).ok,
    ).toBe(false);
  });
});
