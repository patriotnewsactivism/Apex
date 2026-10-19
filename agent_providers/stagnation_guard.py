"""Durable task-local stagnation detection for the Python CLI orchestrator.

OS locks serialize each read/modify/write transaction across processes. Lock
files keep their inode; JSON snapshots use unique temporary files and replace.
Storage and Git errors propagate so callers cannot mistake them for stagnation.
"""

import errno
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATE_DIR = REPO_ROOT / ".apex" / "tasks"
READ_ONLY_ROLES = {"scout", "phantom", "research", "audit", "reviewer"}
COMPLETION_LINE_RE = re.compile(r"^\s*\[APEX_TASK_COMPLETE\]\s*$", re.MULTILINE)


class PersistentStagnationGuard:
    def __init__(
        self,
        state_dir: Optional[Path] = None,
        max_stagnant_turns: int = 2,
        *,
        repo_root: Optional[Path] = None,
        lock_timeout: float = 10,
    ) -> None:
        if max_stagnant_turns < 1 or lock_timeout <= 0:
            raise ValueError("Stagnation threshold and lock timeout must be positive")
        self.repo_root = Path(repo_root) if repo_root is not None else REPO_ROOT
        self.state_dir = Path(state_dir) if state_dir is not None else self.repo_root / ".apex" / "tasks"
        self.max_stagnant_turns = max_stagnant_turns
        self.lock_timeout = lock_timeout
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def _get_task_path(self, task_id: str) -> Path:
        if not isinstance(task_id, str) or not task_id.strip():
            raise ValueError("A nonempty task ID is required")
        safe_id = re.sub(r"[^a-zA-Z0-9_.-]", "_", task_id)[:64]
        # Distinguish a/b from a_b, case variants on Windows, device names,
        # and long IDs with the same prefix. The original ID is never a path.
        digest = hashlib.sha256(task_id.encode("utf-8")).hexdigest()
        return self.state_dir / f"task-{safe_id}-{digest}.json"

    @contextmanager
    def _task_lock(self, task_id: str):
        path = self._get_task_path(task_id).with_suffix(".lock")
        with path.open("a+b") as handle:
            if path.stat().st_size == 0:
                handle.write(b"\0")
                handle.flush()
            deadline = time.monotonic() + self.lock_timeout
            while True:
                handle.seek(0)
                try:
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Timed out acquiring stagnation state lock") from exc
                    time.sleep(0.02)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _load_session(self, task_id: str) -> dict:
        path = self._get_task_path(task_id)
        try:
            session = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"output_hashes": [], "diff_hashes": []}
        if not isinstance(session, dict) or any(
            not isinstance(session.get(key), list)
            or any(not isinstance(value, str) for value in session[key])
            for key in ("output_hashes", "diff_hashes")
        ):
            raise ValueError(f"Invalid stagnation state: {path.name}")
        return session

    def _save_session(self, task_id: str, session: dict) -> None:
        path = self._get_task_path(task_id)
        session["updated_at"] = time.time()
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.state_dir,
                prefix=path.stem + "-", suffix=".tmp", delete=False,
            ) as handle:
                temporary = Path(handle.name)
                json.dump(session, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def compute_workspace_fingerprint(self) -> str:
        """Hash tracked diffs and all untracked content, excluding guard state."""
        def run_git(*args: str) -> bytes:
            result = subprocess.run(
                ["git", *args], cwd=self.repo_root, capture_output=True,
                timeout=10, check=False,
            )
            if result.returncode:
                raise RuntimeError(f"Workspace fingerprint: git {args[0]} exited {result.returncode}")
            return result.stdout

        hasher = hashlib.sha256()
        # A clean commit is real progress too. Exclude .apex here as well as
        # in diff/untracked data; logging-only commits must not reset the guard.
        for entry in run_git("ls-tree", "-r", "-z", "HEAD").split(b"\0"):
            if entry:
                _, raw_path = entry.split(b"\t", 1)
                if raw_path != b".apex" and not raw_path.startswith(b".apex/"):
                    hasher.update(entry + b"\0")
        hasher.update(run_git(
            "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD",
            "--", ".", ":(exclude).apex", ":(exclude).apex/**",
        ))
        untracked = run_git("ls-files", "--others", "--exclude-standard", "-z")
        for raw_path in sorted(filter(None, untracked.split(b"\0"))):
            if raw_path == b".apex" or raw_path.startswith(b".apex/"):
                continue
            hasher.update(b"\0path\0" + raw_path + b"\0content\0")
            path = self.repo_root / os.fsdecode(raw_path)
            if path.is_symlink():
                hasher.update(os.fsencode(os.readlink(path)))
            else:
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(65536), b""):
                        hasher.update(chunk)
        return hasher.hexdigest()

    def evaluate_turn(self, task_id: str, agent_role: str, latest_output: str) -> Tuple[bool, str]:
        role = agent_role.strip().lower()
        normalized = latest_output.strip()
        with self._task_lock(task_id):
            if COMPLETION_LINE_RE.search(normalized):
                self._get_task_path(task_id).unlink(missing_ok=True)
                return True, "Agent emitted [APEX_TASK_COMPLETE]."
            session = self._load_session(task_id)
            outputs = session["output_hashes"]
            out_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
            repeated = bool(normalized and outputs and outputs[-1] == out_hash)
            outputs.append(out_hash)
            # Read-only agents need no filesystem changes (and no Git probe).
            diffs = session["diff_hashes"] if session.get("role") == role else []
            if role not in READ_ONLY_ROLES:
                diffs.append(self.compute_workspace_fingerprint())
            else:
                diffs = []
            window = self.max_stagnant_turns + 1
            session.update(
                output_hashes=outputs[-10:], diff_hashes=diffs[-max(10, window):], role=role,
            )
            self._save_session(task_id, session)
            if repeated:
                return True, f"Agent '{agent_role}' repeated identical output on consecutive turns."
            if len(diffs) >= window and len(set(diffs[-window:])) == 1:
                return True, (
                    f"Write-capable agent '{agent_role}' made zero file content changes "
                    f"across {self.max_stagnant_turns} consecutive turns."
                )
        return False, "Continue"

    def clear_task(self, task_id: str) -> None:
        with self._task_lock(task_id):
            self._get_task_path(task_id).unlink(missing_ok=True)


def evaluate_cycle_guard(hook_input: dict) -> Optional[str]:
    """Called by both Stop hooks before issuing another continuation.

    This stops CLI cycling only; a completion marker never closes an issue or
    marks a production queue task successful. Errors must stop continuation.
    """
    task_id = os.environ.get("NINJA_TASK_ID")
    if not task_id:
        raise ValueError("Cycle stagnation guard requires NINJA_TASK_ID")
    output = hook_input.get("last_assistant_message", "")
    if not isinstance(output, str):
        raise ValueError("last_assistant_message must be text")
    stop, reason = PersistentStagnationGuard().evaluate_turn(
        task_id, os.environ.get("APEX_AGENT_ROLE", "writer"), output,
    )
    return reason if stop else None
