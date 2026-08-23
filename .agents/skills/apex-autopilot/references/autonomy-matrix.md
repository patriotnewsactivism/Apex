# APEX Autonomy Matrix

This matrix defines defaults for the `apex-autopilot` skill. A current explicit user authorization or a stricter repository/system policy can change the effective boundary. Never use a lower-level mechanism to bypass a higher-level gate.

| Action | Default | Notes |
|---|---|---|
| Read repo/source/docs | Auto | Verify branch/ref. |
| Read live health/status | Auto | Prefer direct live evidence. |
| Read authenticated metrics/queues/tokens | Auto | Use existing authorized credentials; never reveal them. |
| Search logs / inspect failures | Auto | Read-only. |
| Run local typecheck/build/tests | Auto | Confirm expected packages actually ran. |
| Create/edit feature-branch files | Auto | Preserve unrelated work. |
| Add tests/diagnostics | Auto | Reversible. |
| Draft email/support/sales/content | Auto | Draft only. |
| Reconfigure local/test agent | Auto | Only if reversible and non-production. |
| Change production agent concurrency/maxIterations | Approval | Runtime production mutation unless a standing policy explicitly authorizes ranges. |
| Create feature branch | Auto | Reversible. |
| Commit locally/on working branch | Auto | Do not include secrets/unrelated files. |
| Push remote branch | Approval if APEX tool gates it | Respect internal tool registry/governance. |
| Create PR | Approval if APEX tool gates it | Can be prepared in advance. |
| Merge to main | Approval | Protected/default branch mutation. |
| Production deploy | Approval | Must verify live commit and behavior afterward. |
| Production rollback | Approval | Prepare rollback target and proof first. |
| Production DB write | Approval unless clearly routine pre-authorized operation | Schema/destructive changes always gated. |
| Schema migration | Approval | Require backup/rollback/verification plan. |
| Delete production data | Approval | High blast radius. |
| Send external email/message | Approval | Unless standing authorization explicitly covers exact class. |
| Make outbound call | Approval | External effect. |
| Publish public content | Approval | External/public effect. |
| Spend money/change billing | Approval | Financial effect. |
| Refund/credit customer | Approval | Financial/customer effect. |
| Rotate secrets/permissions | Approval | Security effect. |
| Disable auth/approval/audit controls | Never by default | Requires exceptional explicit redesign decision and safer substitute. |

## How to increase autonomy safely

When the goal is fewer interruptions, prefer these mechanisms instead of removing gates:

1. Standing policies with narrow scopes and numeric limits.
2. Idempotent actions.
3. Dry-run modes.
4. Feature branches and preview environments.
5. Automatic tests and live verification.
6. Precomputed rollback plans.
7. Approval batching by one coherent release/action.
8. Automatic escalation deduplication.
9. Safe runtime envelopes, e.g. approved concurrency range.
10. Audit logs with exact actor/action/result.

A mature autonomous system does not eliminate control; it moves control to well-defined policy boundaries.
