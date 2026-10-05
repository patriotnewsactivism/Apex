export type CopilotAction =
  | { type: "navigate"; page: string }
  | { type: "search"; page: "leads" | "contacts"; query: string }
  | {
      type: "setFilter";
      page: "leads" | "contacts";
      field: string;
      value: string | boolean | null;
    }
  | { type: "openRecord"; recordType: "lead" | "contact"; id: string };

export type CopilotPanelAction = Extract<
  CopilotAction,
  { type: "search" | "setFilter" | "openRecord" }
>;

export const COPILOT_PANEL_EVENT = "apex:copilot-panel-action";

export interface CopilotUiController {
  available: boolean;
  active: boolean;
  busy: boolean;
  sessionId: string;
  start: () => void;
  stop: (reason?: string) => void;
  execute: (
    actions: CopilotAction[],
    narrate: (message: string) => void,
  ) => Promise<void>;
}

export function describeCopilotAction(action: CopilotAction): string {
  switch (action.type) {
    case "navigate":
      return `Opening ${action.page.replace(/-/g, " ")}`;
    case "search":
      return `Searching ${action.page} for “${action.query}”`;
    case "setFilter":
      return `Setting ${action.page} filter ${action.field} to ${String(action.value ?? "any")}`;
    case "openRecord":
      return `Opening ${action.recordType} ${action.id.slice(0, 8)}`;
  }
}

export function copilotActionTarget(action: CopilotAction): string | null {
  switch (action.type) {
    case "navigate":
      return `#nav-${CSS.escape(action.page)}`;
    case "search":
      return `[data-copilot-target="${action.page}-search"]`;
    case "setFilter":
      if (action.field === "q")
        return `[data-copilot-target="${action.page}-search"]`;
      return `[data-copilot-target="${action.page}-filter-${CSS.escape(action.field)}"]`;
    case "openRecord":
      return `[data-copilot-record="${CSS.escape(action.id)}"]`;
  }
}
