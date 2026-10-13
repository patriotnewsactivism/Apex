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
Copilot status, action generation, and audit writes also require the separate
operator session minted by a dashboard password login; the admin bearer alone
cannot activate the mode.

Accepted and completed actions are written to `audit_events` as
`actorId=copilot`, on behalf of Matthew. Audit failure is surfaced as an action
failure rather than silently claiming success.

Medium-risk actions are intentionally absent from the v1 registry. A future
implementation must render a human-only **Do it?** control; the AI must never
activate that control itself.

## When the toggle is missing on one device but present on another

The toggle is gated on two independent things, and the dashboard used to
conflate them:

- `VITE_FEATURE_COPILOT` — build-time, identical on every device;
- an **operator dashboard session** — per device, minted only by a password
  login, good for 12 hours.

The dashboard's auth gate checks only the long-lived bearer token. So a browser
can be fully signed in — every panel loading real data — while holding **no
operator session at all**, and then `/chat/copilot/status` answers 403. That is
the normal state of a phone whose stored login predates operator sessions: its
token still validates, so it is never asked to sign in again.

Because the client previously read any non-`enabled` answer as "feature off", it
rendered no Copilot control and said nothing. Copilot was simply absent on that
device with no way to discover why.

The client now distinguishes the 403 and shows **Apex Copilot · Sign in**, which
routes back through the password login and mints a fresh session. If you see it,
signing in again is the fix; nothing is misconfigured. `resolveCopilotAvailability`
in `packages/dashboard/src/copilot/availability.ts` is the single place that
decides, and it is unit-tested from `copilot-actions.test.ts`.

Do not "fix" this by minting an operator session from the bearer token. That
credential exists so a bot holding only `APEX_ADMIN_TOKEN` cannot authorize an
outbound send; a bearer-only mint endpoint would remove that boundary entirely.

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
