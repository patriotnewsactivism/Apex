/**
 * Build-time gate for the Apex Copilot UI. Vite leaves an unset value as
 * undefined, so the toggle cannot appear unless the flag is explicitly true.
 * The API applies its own independent FEATURE_COPILOT gate.
 */
export function isCopilotClientFeatureEnabled(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}
