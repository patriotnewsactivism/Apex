# Local CLI optimizations

These controls apply to the local/Python CLI harness. The TypeScript production
workforce retains its existing queue, repetition, and checkpoint controls.

## Preflight

Run from any directory:

```powershell
& C:\apex\.agents\skills\apex-autopilot\scripts\apex-preflight.ps1
$gateExit = $LASTEXITCODE
```

| Exit | Meaning | Scheduler action |
| --- | --- | --- |
| 0 | Open task in root `PLAN.md` or `CHECKLIST.md` | Start the intended agent command |
| 10 | No open Markdown tasks outside fenced code | Skip this wakeup |
| 20 | Recent/held Git lock or a Git process with a lock present | Retry on a later wakeup |
| 1 | File access, metric write, or other preflight failure | Report an error; do not treat as no work |

Store the exit code immediately after invoking the script. Only `0` admits a
run. The script calls no LLM or network endpoint in its default mode. It appends
UTC outcomes to `.apex/wakeup_metrics.log`; simultaneous writers serialize their
appends. Inspect it with `Get-Content C:\apex\.apex\wakeup_metrics.log -Tail 20`.

The task scanner recognizes backtick and tilde fences, matching their character
and minimum closing length. A fence with trailing text does not close a block.
Existing but unreadable task files cause an error instead of a clean skip.

The gate checks Git processes before accepting an old `.ninja-git.lock` as idle.
It probes exclusive access on Windows and `flock` ownership on POSIX. It
preserves the file, including stale files, because deleting a shared lock path
can break coordination with sync/upgrade processes. `-StaleLockMinutes` defaults
to 30. This is a point-in-time admission check, not a mutex held throughout the
agent run; Git writers still need their normal locks.

The original network diagnostics remain available with `-Diagnostics`:

```powershell
& C:\apex\.agents\skills\apex-autopilot\scripts\apex-preflight.ps1 -Diagnostics
```

That mode uses the existing `APEX_BASE_URL` / `APEX_ADMIN_TOKEN` configuration.
The shell preflight remains a health-diagnostics script. No scheduler has been
installed or modified by these changes. The issue-driven Python orchestrator
does not use Markdown task presence as its admission rule; do not gate its
GitHub issue queue with an unrelated empty checklist.

## Persistent stagnation guard

Both Python orchestrator Stop hooks call
`PersistentStagnationGuard.evaluate_turn(task_id, role, output)` before requesting
another continuation. `processes/orchestrator.py` passes `NINJA_TASK_ID` and
`APEX_AGENT_ROLE` to both harnesses; the latter is the agent's configured name so
Scout and Phantom receive their read-only exemptions. Non-cycle runs are
unaffected. An armed cycle missing its task ID stops with a visible diagnostic.

Each task gets a readable, bounded filename plus the full SHA-256 of the original
ID under `.apex/tasks/`, preventing sanitized-ID and Windows case collisions.
An OS lock serializes the entire task update; unique temporary files, flush,
fsync, and atomic replacement prevent partial JSON reads. Lock files remain in
place and OS ownership is released on process exit. Corrupt state, unavailable
Git, and failed writes stop continuation with stderr and a hook stop response.

The guard stops on consecutive identical nonempty output, a standalone
`[APEX_TASK_COMPLETE]` line, or three equal workspace observations (two intervals
without changes by default). The workspace fingerprint includes committed file
content, staged/unstaged diffs, and full untracked files, excluding `.apex` in all
three paths. It is a repository-wide observation: concurrent changes by another
task may postpone filesystem stagnation detection. Scout, Phantom, research,
audit, and reviewer are exempt from the filesystem rule, and still subject to
identical-output detection. Changing roles resets the filesystem window.

A completion marker clears task JSON and ends CLI continuation; it does not
close a GitHub issue or mark a production task successful. Existing verification
requirements remain authoritative. `clear_task(task_id)` also clears a task's
history under the same lock.

## Output compression and monitor compatibility

```powershell
Get-Content .\tool-output.txt -Raw | python agent_providers/codex_hooks/codex_length_hook.py --max-chars 4000
python agent_providers/codex_hooks/codex_length_hook.py --file .\tool-output.txt --max-chars 1000
```

`compress_tool_output` strips ANSI escapes, collapses adjacent duplicate lines,
and retains a head/tail excerpt with an omission count. Its entire result fits
the requested character budget; tiny budgets return a prefix and nonpositive
budgets return an empty string. The CLI default is 4000, overridable with
`APEX_MAX_TOOL_OUTPUT_CHARS` or `--max-chars`. Invalid environment values cause a
visible command-line error.

Compression is an explicit utility for callers that consume tool output. It is
not automatically applied to Codex's internal tool messages or provider JSON
streams. The provider registers the same script with `--hook`, preserving its
PostToolUse JSON protocol and existing monitor-length handoff. Updating that
configuration takes effect when the provider next runs setup.

`.claude/settings.json` adds the requested Read deny patterns while preserving
the existing plugin settings. These are Claude Read-tool restrictions; other
tool permissions retain their normal policy.

## Verification

```powershell
python -m unittest discover -s tests -p test_apex_optimizations.py -v
```

The suite uses temporary repositories and task files, mocked hook inputs, real
OS locks, and concurrent processes. It calls no agent CLI or production service.
