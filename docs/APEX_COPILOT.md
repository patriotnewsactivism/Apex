# Apex Copilot — Build 5 MVP

Apex Copilot is an authenticated, dashboard-only control mode in the floating
APEX operator chat. It does not perform pixel automation and cannot access the
operating system or desktop.

## Enable locally

The feature is off by default. Export both local development flags before
starting (or restarting) the API and Vite processes:

```bash
export FEATURE_COPILOT=true
export VITE_FEATURE_COPILOT=true
pnpm run dev
```

Do not add these enabled values to production configuration. The client flag
controls toggle visibility; the independent server flag controls the chat
tool, action validation, and audit endpoint.

## Use

1. Log in to the operator dashboard.
2. Open APEX Command and turn on **Apex Copilot**.
3. Ask Apex to open a safe dashboard page, search contacts/prospects, apply an
   allowed filter, or open a contact using its exact record id.
4. Watch the highlighted target and narrated steps in chat.
5. Press **Stop** or `Esc` at any time. The mode also turns off after ten
   minutes without operator/Copilot activity, on logout, or when the tab ends.

Manual interaction outside the chat stops the current Copilot run so the
operator always takes priority.

## Safety boundary

The server exposes an allow-listed structured action tool. It does not expose
raw selectors or clicks. Sends, calls, invites, pending-send release,
approval/confirmation/code entry, kill-switch or outbound-policy changes,
secrets, billing/payments, deletes, merges, user/permission changes, deploys,
and rollbacks are denied. Sensitive pages are not Copilot navigation targets.
The normal chat's mutation tools are removed while Copilot mode is active.

Accepted and completed actions are written to `audit_events` as
`actorId=copilot`, on behalf of Matthew. Audit failure is surfaced as an action
failure rather than silently claiming success.

Medium-risk actions are intentionally absent from the v1 registry. A future
implementation must render a human-only **Do it?** control; the AI must never
activate that control itself.

## Deliberately deferred

- short-lived, server-bound Copilot session tokens;
- voice readback of UI actions;
- full per-minute and per-session action rate limits;
- undo handlers for reversible actions;
- broader form/layout actions and human-confirmed medium-risk actions.

Build 5 tracking, documentation, and future extracted modules may also live in
the companion repository:
[patriotnewsactivism/apex-copilot](https://github.com/patriotnewsactivism/apex-copilot).
The dashboard implementation remains in `patriotnewsactivism/Apex`.
