"""Deterministic stdlib tests; no agent CLI, network, or production state."""

import concurrent.futures
import importlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from agent_providers.codex_hooks import codex_length_hook as length_hook
from agent_providers.stagnation_guard import PersistentStagnationGuard


def concurrent_turn(state_dir, index):
    guard = PersistentStagnationGuard(Path(state_dir))
    return guard.evaluate_turn("same/task", "scout", f"finding {index}")


class LengthFilterTests(unittest.TestCase):
    def test_all_small_limits_and_banner_accounting(self):
        raw = "HEADER\n" + "0123456789" * 300 + "\nTAIL"
        for limit in range(-2, 501):
            result = length_hook.compress_tool_output(raw, limit)
            self.assertLessEqual(len(result), max(0, limit))
        result = length_hook.compress_tool_output(raw, 200)
        self.assertTrue(result.startswith("HEADER"))
        self.assertTrue(result.endswith("TAIL"))
        import re

        marker = re.search(r"\n\n\.\.\. \[APEX LENGTH HOOK: OMITTED (\d+) CHARS\] \.\.\.\n\n", result)
        self.assertEqual(len(raw) - (len(result) - len(marker[0])), int(marker[1]))

    def test_ansi_and_adjacent_repetitions(self):
        result = length_hook.compress_tool_output("\x1b[31ma\x1b[0m  \na\na\nb\nb")
        self.assertEqual(result, "a\n  ... [line repeated 2 more times] ...\nb\n  ... [line repeated 1 more times] ...")

    def test_pipe_file_environment_and_hook_protocol(self):
        command = [sys.executable, str(ROOT / "agent_providers/codex_hooks/codex_length_hook.py")]
        env = {**os.environ, "APEX_MAX_TOOL_OUTPUT_CHARS": "3", "NINJA_MONITOR_RUN": "0"}
        result = subprocess.run(command, input="abcdef", text=True, capture_output=True, env=env, check=True)
        self.assertEqual(result.stdout, "abc")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.txt"
            source.write_text("abcdef", encoding="utf-8")
            result = subprocess.run(command + ["--file", str(source), "--max-chars", "2"], text=True, capture_output=True, env=env, check=True)
            self.assertEqual(result.stdout, "ab")
        result = subprocess.run(command + ["--hook"], input="{}", text=True, capture_output=True, env=env, check=True)
        self.assertEqual(result.stdout, "")
        env["APEX_MAX_TOOL_OUTPUT_CHARS"] = "invalid"
        result = subprocess.run(command, input="text", text=True, capture_output=True, env=env)
        self.assertNotEqual(result.returncode, 0)

    def test_monitor_handoff_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            transcript = Path(directory) / "transcript.jsonl"
            transcript.write_text('\n'.join(json.dumps({"type": "response_item"}) for _ in range(3)), encoding="utf-8")
            with mock.patch.dict(os.environ, {"NINJA_MONITOR_RUN": "1"}), mock.patch.multiple(
                length_hook, MONITOR_TURNS_THRESHOLD=2,
                STATE_FILE_PATH=Path(directory) / "state.json", LOG_FILE=Path(directory) / "hook.log",
            ):
                result = length_hook.build_hook_output(hook_input={"transcript_path": str(transcript)})
                self.assertIs(result["continue"], False)
                self.assertEqual(length_hook.build_hook_output(hook_input={"transcript_path": str(transcript)}), {})
        self.assertIn("{length_hook} --hook", (ROOT / "agent_providers/codex/codex_provider.py").read_text())


class StagnationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        (self.repo / "tracked.txt").write_text("initial", encoding="utf-8")
        (self.repo / ".apex").mkdir()
        (self.repo / ".apex/tracked-state.json").write_text("{}")
        self.git("add", ".")
        self.git("commit", "-qm", "initial")
        self.guard = PersistentStagnationGuard(repo_root=self.repo)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

    def test_state_ignored_and_unchanged_workspace_stops(self):
        baseline = self.guard.compute_workspace_fingerprint()
        self.assertFalse(self.guard.evaluate_turn("one", "writer", "first")[0])
        (self.repo / ".apex/tracked-state.json").write_text('{"updated":true}')
        self.assertEqual(baseline, self.guard.compute_workspace_fingerprint())
        self.assertFalse(self.guard.evaluate_turn("one", "writer", "second")[0])
        guard = PersistentStagnationGuard(repo_root=self.repo)
        self.assertTrue(guard.evaluate_turn("one", "writer", "third")[0])

    def test_full_content_tracked_staged_untracked_and_deletions(self):
        baseline = self.guard.compute_workspace_fingerprint()
        (self.repo / "tracked.txt").write_text("changed")
        self.assertNotEqual(baseline, self.guard.compute_workspace_fingerprint())
        self.git("add", "tracked.txt")
        self.assertNotEqual(baseline, self.guard.compute_workspace_fingerprint())
        path = self.repo / "space and ü.txt"
        path.write_bytes(b"a" * 70000)
        before = self.guard.compute_workspace_fingerprint()
        path.write_bytes(b"a" * 69999 + b"b")
        self.assertNotEqual(before, self.guard.compute_workspace_fingerprint())
        path.unlink()
        before = self.guard.compute_workspace_fingerprint()
        (self.repo / "tracked.txt").unlink()
        self.assertNotEqual(before, self.guard.compute_workspace_fingerprint())

    def test_progress_resets_window(self):
        for index in range(5):
            (self.repo / "tracked.txt").write_text(str(index))
            self.assertFalse(self.guard.evaluate_turn("progress", "writer", str(index))[0])

    def test_committed_progress_and_state_only_commits(self):
        for index in range(4):
            (self.repo / "tracked.txt").write_text(str(index))
            self.git("add", "tracked.txt")
            self.git("commit", "-qm", f"progress {index}")
            self.assertFalse(self.guard.evaluate_turn("committed", "writer", str(index))[0])
        before = self.guard.compute_workspace_fingerprint()
        (self.repo / ".apex/tracked-state.json").write_text('{"log":1}')
        self.git("add", ".apex/tracked-state.json")
        self.git("commit", "-qm", "state only")
        self.assertEqual(before, self.guard.compute_workspace_fingerprint())

    def test_role_change_resets_filesystem_window(self):
        for role, output in (("writer", "a"), ("writer", "b"), ("Scout", "c"), ("writer", "d")):
            self.assertFalse(self.guard.evaluate_turn("roles", role, output)[0])

    def test_readonly_roles_repeat_detection_and_completion(self):
        for role in ("Scout", "Phantom", "research", "audit", "reviewer"):
            for index in range(4):
                self.assertFalse(self.guard.evaluate_turn(role, role, str(index))[0])
            self.assertTrue(self.guard.evaluate_turn(role, role, "3")[0])
            self.assertTrue(self.guard.evaluate_turn(role, role, "done\n[APEX_TASK_COMPLETE]\n")[0])
            self.assertFalse(self.guard._get_task_path(role).exists())
        self.assertFalse(self.guard.evaluate_turn("inline", "scout", "quote [APEX_TASK_COMPLETE] in prose")[0])

    def test_ids_are_isolated_and_bounded(self):
        ids = ["a/b", "a_b", "ABC", "abc", "..", "CON", "", "a" * 500]
        paths = [self.guard._get_task_path(value) for value in ids if value]
        self.assertEqual(len(set(str(path).lower() for path in paths)), len(paths))
        for path in paths:
            self.assertEqual(path.parent, self.guard.state_dir)
            self.assertLess(len(path.name), 150)
        with self.assertRaises(ValueError):
            self.guard._get_task_path("")

    def test_corrupt_state_git_errors_and_lock_timeout_are_visible(self):
        self.guard._get_task_path("bad").write_text("[]")
        with self.assertRaises(ValueError):
            self.guard.evaluate_turn("bad", "writer", "text")
        with mock.patch("agent_providers.stagnation_guard.subprocess.run", return_value=subprocess.CompletedProcess([], 128, b"", b"error")):
            with self.assertRaises(RuntimeError):
                self.guard.compute_workspace_fingerprint()
        second = PersistentStagnationGuard(repo_root=self.repo, lock_timeout=0.05)
        with self.guard._task_lock("locked"):
            with self.assertRaises(TimeoutError):
                second.evaluate_turn("locked", "scout", "text")

    def test_concurrent_same_task_updates_are_not_lost(self):
        with concurrent.futures.ProcessPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(concurrent_turn, str(self.guard.state_dir), index) for index in range(8)]
            for future in futures:
                self.assertFalse(future.result(timeout=30)[0])
        session = self.guard._load_session("same/task")
        self.assertEqual(len(session["output_hashes"]), 8)
        self.assertEqual(len(set(session["output_hashes"])), 8)
        self.assertFalse(list(self.guard.state_dir.glob("*.tmp")))

    def test_stop_hooks_invoke_guard_and_stop_on_errors(self):
        hooks = [importlib.import_module(name) for name in (
            "orchestrator_stop_hook", "agent_providers.codex_hooks.codex_stop_hook",
        )]
        for hook in hooks:
            stdout, stderr = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, {"NINJA_CYCLE_RUN": "1"}), mock.patch("sys.stdin") as stdin, mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", stderr), mock.patch.object(hook, "_log"), mock.patch("agent_providers.stagnation_guard.evaluate_cycle_guard", side_effect=RuntimeError("unavailable")):
                stdin.read.return_value = '{"last_assistant_message":"text"}'
                with self.assertRaises(SystemExit):
                    hook.main()
            self.assertIs(json.loads(stdout.getvalue())["continue"], False)
            self.assertIn("unavailable", stderr.getvalue())


@unittest.skipUnless(shutil.which("powershell") or shutil.which("pwsh"), "PowerShell required")
class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.script = self.repo / ".agents/skills/apex-autopilot/scripts/apex-preflight.ps1"
        self.script.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / ".agents/skills/apex-autopilot/scripts/apex-preflight.ps1", self.script)
        self.wrapper = self.repo / "test-wrapper.ps1"
        self.wrapper.write_text('''param([string]$ScriptPath)
function Get-Process {
    param($Name, $ErrorAction)
    if ($env:APEX_TEST_GIT_RUNNING -eq '1') { [pscustomobject]@{ Name = 'git' } }
}
& $ScriptPath
exit $LASTEXITCODE
''', encoding="utf-8")

    def run_gate(self, code, *, running=False):
        result = subprocess.run([
            shutil.which("powershell") or shutil.which("pwsh"), "-NoProfile", "-File",
            str(self.wrapper), str(self.script),
        ], cwd=tempfile.gettempdir(), capture_output=True, text=True,
            env={**os.environ, "APEX_TEST_GIT_RUNNING": "1" if running else "0"}, timeout=20)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def test_no_tasks_checked_tasks_and_real_task(self):
        self.run_gate(10)
        (self.repo / "PLAN.md").write_text("- [x] done\n- [ ]   \n")
        self.run_gate(10)
        (self.repo / "CHECKLIST.md").write_text("  + [ ] action\n")
        self.run_gate(0)
        metrics = (self.repo / ".apex/wakeup_metrics.log").read_text()
        self.assertIn("status=NO_WORK | exit_code=10", metrics)
        self.assertIn("status=WORK_READY | exit_code=0", metrics)
        self.assertNotIn("vert", metrics)

    def test_fence_character_length_trailing_text_and_unclosed_fences(self):
        for source in (
            "```python\n- [ ] code\n```\n",
            "~~~~\n```\n- [ ] code\n~~~\n- [ ] still code\n~~~~\n",
            "````\n```\n- [ ] code\n```` trailing\n- [ ] still code\n````\n",
            "```\n- [ ] unclosed\n",
        ):
            (self.repo / "PLAN.md").write_text(source)
            self.run_gate(10)
        (self.repo / "PLAN.md").write_text("```\n- [ ] code\n```\n- [ ] real\n")
        self.run_gate(0)

    def test_recent_active_and_stale_locks(self):
        (self.repo / "PLAN.md").write_text("- [ ] real\n")
        lock = self.repo / ".ninja-git.lock"
        lock.write_text("")
        self.run_gate(20)
        old = time.time() - 3600
        os.utime(lock, (old, old))
        self.run_gate(20, running=True)
        self.assertTrue(lock.exists())
        self.run_gate(0)
        self.assertTrue(lock.exists())

    def test_stale_lock_with_open_owner_is_preserved(self):
        (self.repo / "PLAN.md").write_text("- [ ] real\n")
        lock = self.repo / ".ninja-git.lock"
        lock.write_text("")
        old = time.time() - 3600
        os.utime(lock, (old, old))
        with lock.open("rb") as handle:
            if os.name != "nt":
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            self.run_gate(20)
        self.assertTrue(lock.exists())

    def test_task_read_errors_do_not_become_clean_skip(self):
        (self.repo / "PLAN.md").mkdir()
        result = self.run_gate(1)
        self.assertIn("ERROR", result.stderr)


if __name__ == "__main__":
    unittest.main()
