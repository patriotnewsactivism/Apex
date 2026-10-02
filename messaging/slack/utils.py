"""Slack-specific user ID → display name resolution for monitor prompts."""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

# Align with list_users() file-cache intent (1 hour).
USER_CACHE_TTL_SECONDS = 3600

USER_MENTION_RE = re.compile(r"<@([UW][A-Z0-9]+)(?:\|([^>]+))?>")
SPECIAL_MENTION_RE = re.compile(r"<!(here|channel|everyone)>")


def display_name_from_slack_user(user: Dict[str, Any]) -> str:
    """Best display name from a Slack users.list / users.info user object."""
    profile = user.get("profile") if isinstance(user.get("profile"), dict) else {}
    return (
        user.get("real_name")
        or profile.get("real_name")
        or profile.get("display_name")
        or profile.get("display_name_normalized")
        or user.get("name")
        or profile.get("name")
        or user.get("id")
        or ""
    )


def _name_from_profile(profile: Optional[Dict[str, Any]]) -> Optional[str]:
    if not profile:
        return None
    return (
        profile.get("real_name") or profile.get("display_name") or profile.get("name")
    )


def resolve_slack_sender_name_from_message(msg: Dict[str, Any]) -> Optional[str]:
    """Return a display name from inline message fields only (steps 1–4)."""
    user_id = msg.get("user") or ""

    sender = msg.get("sender")
    if isinstance(sender, dict):
        name = sender.get("display_name")
        if name:
            return str(name)

    name = _name_from_profile(msg.get("user_profile"))
    if name:
        return name

    username = msg.get("username")
    if username:
        return str(username)

    bot_profile = msg.get("bot_profile")
    if isinstance(bot_profile, dict):
        bot_name = bot_profile.get("name")
        if bot_name:
            return str(bot_name)

    from_user = msg.get("from_user") or msg.get("from")
    if from_user and user_id and str(from_user) != str(user_id):
        return str(from_user)

    return None


def resolve_slack_sender_name(
    msg: Dict[str, Any],
    lookup: Callable[[str], str],
) -> str:
    """Resolve sender display name; ``lookup`` covers cache + users.info."""
    inline = resolve_slack_sender_name_from_message(msg)
    if inline:
        return inline

    user_id = msg.get("user") or ""
    if not user_id:
        return str(msg.get("username") or "Unknown")

    return lookup(user_id)


def mention_user_ids_needing_lookup(text: str) -> Set[str]:
    """User mention IDs in ``text`` that lack a piped Slack label."""
    if not text:
        return set()
    ids: Set[str] = set()
    for match in USER_MENTION_RE.finditer(text):
        if not match.group(2):
            ids.add(match.group(1))
    return ids


def collect_unresolved_user_ids(
    candidates: List[Tuple[Dict[str, Any], bool]],
) -> Set[str]:
    """IDs that still need cache/API lookup after inline resolution."""
    unresolved: Set[str] = set()
    for candidate, _ in candidates:
        user_id = candidate.get("user") or ""
        if user_id and not resolve_slack_sender_name_from_message(candidate):
            unresolved.add(user_id)
        unresolved.update(mention_user_ids_needing_lookup(candidate.get("text") or ""))
    return unresolved


def resolve_slack_mentions(
    text: str,
    lookup: Callable[[str], str],
    user_cache: Optional[Dict[str, str]] = None,
) -> str:
    """Replace Slack user/special mention tokens with ``@Name`` style text."""
    if not text:
        return text

    def replace_user(match: re.Match[str]) -> str:
        user_id = match.group(1)
        label = match.group(2)
        if label:
            if user_cache is not None:
                user_cache[user_id] = label
            return f"@{label}"
        name = lookup(user_id)
        return f"@{name}" if name else match.group(0)

    def replace_special(match: re.Match[str]) -> str:
        return f"@{match.group(1)}"

    text = SPECIAL_MENTION_RE.sub(replace_special, text)
    return USER_MENTION_RE.sub(replace_user, text)
