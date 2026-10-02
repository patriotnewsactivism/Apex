#!/usr/bin/env python3
"""
Slack Interface CLI

A command-line tool and Python API for interacting with Slack workspaces.
Supports agent-based messaging with custom avatars, file uploads, and more.

Token Sources (in priority order):
    1. Cached config (~/.agent_settings.json) - persisted from first connection
    2. /dev/shm/mcp-token - Auto-populated when you click 'Connect' in chat
    3. Environment variable: SLACK_BOT_TOKEN

Token Type:
    - Bot Token (xoxb-*) ONLY — user tokens (xoxp-*) are NOT supported

Required Scopes:
    - channels:read        - List channels
    - channels:history     - Read channel messages
    - chat:write           - Send messages
    - users:read           - List users
    - files:write          - Upload files (for file uploads)
    - files:read           - Read file info / permalinks
    - chat:write.customize - Post messages as a specific agent identity
                             (custom username + icon_url). Required for
                             agent-authored file uploads.
    - links:read           - Allow Slack to unfurl its own file permalinks
                             (required for agent-authored file previews).

First-Time Setup:
    1. Set your default channel:
        python slack_interface.py config --set-channel "#your-channel"

    2. Set your default agent:
        python slack_interface.py config --set-agent nova

Usage:
    python slack_interface.py --help
    python slack_interface.py config                    # Show/set configuration
    python slack_interface.py agents                    # List all available agents
    python slack_interface.py channels                  # List all channels
    python slack_interface.py users                     # List all users
    python slack_interface.py say "message"             # Send as default agent
    python slack_interface.py read                      # Read from default channel
    python slack_interface.py upload file.png           # Upload file to default channel

Configuration:
    The tool uses a config file at ~/.agent_settings.json:

    {
        "default_channel": "#logo-creator",
        "default_channel_id": "C0AAAAMBR1R",
        "default_agent": "nova",
        "workspace": "RenovateAI"
    }

    Set default channel:
        python slack_interface.py config --set-channel "#logo-creator"

    Set default agent:
        python slack_interface.py config --set-agent nova

Agents:
    nova  - Product Manager (🌟 purple)
    pixel - UX Designer (🎨 pink)
    bolt  - Full-Stack Developer (⚡ yellow)
    scout - QA Engineer (🔍 green)

Examples:
    # First-time setup
    python slack_interface.py config --set-channel "#logo-creator"
    python slack_interface.py config --set-agent pixel

    # Send message as configured agent
    python slack_interface.py say "Sprint planning at 2pm!"

    # Upload file with comment
    python slack_interface.py upload designs/mockup.png -m "New design ready!"

    # Read recent messages
    python slack_interface.py read -l 20
"""

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests
from clients.agent_event_cache_client import AgentEventCacheClient
from clients.agent_event_cache_models import (
    AddCompletedActionRequest,
    CompleteActivityRequest,
    GetMessagesRequest,
    MessageProvider,
    ReactRequest,
    SendMessageRequest,
    StartActivityRequest,
    TickActivityRequest,
    WelcomeRequest,
)
from constants import (
    AGENT_SETTINGS_PATH,
    MONITOR_SERVICE_NAME,
)
from core.config import refresh_config, save_agent_messages
from core.logging import get_logger
from messaging.base import MessagingInterface
from messaging.cache_identity import CacheMessage
from messaging.message_utils import (
    classify_message_type,
    convert_sandbox_urls,
    extract_file_attachments,
    resolve_reply_thread,
)
from messaging.monitoring import (
    NO_MESSAGE_STATES,
    MessageStateBatch,
    clear_live_progress,
    publish_message_handled,
)
from messaging.pending import FileAttachment, PendingMessage
from messaging.slack.slack_md_blocks import md_to_slack_blocks
from messaging.slack.utils import (
    USER_CACHE_TTL_SECONDS,
    collect_unresolved_user_ids,
    display_name_from_slack_user,
    resolve_slack_mentions,
    resolve_slack_sender_name,
)

logger = get_logger(MONITOR_SERVICE_NAME)


# Markdown to Slack mrkdwn conversion (REQUIRED)
try:
    from slackify_markdown import slackify_markdown
except ImportError:
    print("=" * 70, file=sys.stderr)
    print("❌ MISSING REQUIRED DEPENDENCY: slackify-markdown", file=sys.stderr)
    print("=" * 70, file=sys.stderr)
    print("", file=sys.stderr)
    print(
        "The 'slackify-markdown' package is required for Slack message formatting.",
        file=sys.stderr,
    )
    print("", file=sys.stderr)
    print("💡 To install, run:", file=sys.stderr)
    print("   pip install -r requirements.txt", file=sys.stderr)
    print("", file=sys.stderr)
    print("   Or install directly:", file=sys.stderr)
    print("   pip install slackify-markdown", file=sys.stderr)
    print("=" * 70, file=sys.stderr)
    sys.exit(1)


# ============================================================================
# Agent Configuration
# ============================================================================
# Each agent has a unique identity with custom avatar for Slack messages.
# Avatars are hosted on a public URL and displayed in Slack when sending messages.

AVATAR_BASE_URL = (
    "https://sites.super.betamyninja.ai/03e7e7b7-929a-4476-a11d-d7acad3951a4/a90f52f3"
)

AGENT_AVATARS = {
    "nova": {
        "name": "Nova",
        "role": "Product Manager",
        "emoji": "🌟",
        "color": "purple",
        "icon_url": f"{AVATAR_BASE_URL}/nova.png",
        "icon_emoji": ":star:",  # Fallback if icon_url not supported
    },
    "pixel": {
        "name": "Pixel",
        "role": "UX Designer",
        "emoji": "🎨",
        "color": "pink",
        "icon_url": f"{AVATAR_BASE_URL}/pixel.png",
        "icon_emoji": ":art:",
    },
    "bolt": {
        "name": "Bolt",
        "role": "Full-Stack Developer",
        "emoji": "⚡",
        "color": "yellow",
        "icon_url": f"{AVATAR_BASE_URL}/bolt.png",
        "icon_emoji": ":zap:",
    },
    "scout": {
        "name": "Scout",
        "role": "QA Engineer",
        "emoji": "🔍",
        "color": "green",
        "icon_url": f"{AVATAR_BASE_URL}/scout.png",
        "icon_emoji": ":mag:",
    },
    "ninja": {
        "name": os.environ.get("NINJA_AGENT_NAME", "Ninja"),
        "role": "Browser Automation Agent",
        "emoji": os.environ.get("NINJA_AGENT_EMOJI", "🥷"),
        "color": "blue",
        "icon_url": f"{AVATAR_BASE_URL}/ninja.png",
        "icon_emoji": ":ninja:",
    },
}


def get_agent_avatar(agent_name: str) -> Optional[Dict[str, str]]:
    """
    Get avatar configuration for an agent by name.

    Args:
        agent_name: Agent identifier (nova, pixel, bolt, scout)

    Returns:
        Dict with agent info (name, role, emoji, color, icon_url, icon_emoji)
        or None if agent not found
    """
    return AGENT_AVATARS.get(agent_name.lower())


# ============================================================================
# Configuration Management
# ============================================================================
# Configuration is persisted to ~/.agent_settings.json and includes:
# - default_channel: Channel name (e.g., "#logo-creator")
# - default_channel_id: Channel ID (e.g., "C0AAAAMBR1R") - preferred for API calls
# - default_agent: Default agent for 'say' command
# - workspace: Workspace name (informational)


@dataclass
class SlackConfig:
    """
    Configuration container for Slack Interface.

    Attributes:
        default_channel: Channel name (e.g., "#logo-creator")
        default_channel_id: Channel ID for API calls (e.g., "C0AAAAMBR1R")
        default_team_id: Slack team/workspace ID (e.g., "T0A9Q27KD1T") —
            resolved from auth.test on first token load. Together with
            default_channel_id this forms the stable
            "<team_id>.<channel_id>" identifier used by downstream
            integrations such as Pipedream's external_user_id.
        default_team_name: Team display name (e.g., "RenovateAI")
        default_team_domain: Slack subdomain (e.g., "renovateai-hq")
        default_agent: Default agent for say command (nova, pixel, bolt, scout)
        workspace: Workspace name (informational only, mirrors default_team_name)
        bot_token: Cached bot token (xoxb-*)
    """

    default_channel: Optional[str] = None
    default_channel_id: Optional[str] = None
    default_team_id: Optional[str] = None
    default_team_name: Optional[str] = None
    default_team_domain: Optional[str] = None
    default_agent: Optional[str] = None
    workspace: Optional[str] = None
    bot_token: Optional[str] = None

    @classmethod
    def load(cls, filepath=AGENT_SETTINGS_PATH) -> "SlackConfig":
        """
        Load configuration from JSON file.

        Args:
            filepath: Path to config file (default: ~/.agent_settings.json)

        Returns:
            SlackConfig instance with loaded values (or defaults if file missing)
        """
        config = cls()
        try:
            if os.path.exists(filepath):
                with open(filepath, "r") as f:
                    data = json.load(f)
                config.default_channel = data.get("default_channel")
                config.default_channel_id = data.get("default_channel_id")
                config.default_team_id = data.get("default_team_id")
                config.default_team_name = data.get("default_team_name")
                config.default_team_domain = data.get("default_team_domain")
                config.default_agent = data.get("default_agent")
                config.workspace = data.get("workspace")
                config.bot_token = data.get("bot_token")
        except Exception as e:
            print(f"⚠️ Warning: Could not load config: {e}", file=sys.stderr)
        return config

    def save(self, filepath=AGENT_SETTINGS_PATH, quiet: bool = False) -> None:
        """
        Save configuration to JSON file.

        Args:
            filepath: Path to save config (default: ~/.agent_settings.json)
            quiet: If True, suppress success message
        """
        data = {
            "default_channel": self.default_channel,
            "default_channel_id": self.default_channel_id,
            "default_team_id": self.default_team_id,
            "default_team_name": self.default_team_name,
            "default_team_domain": self.default_team_domain,
            "default_agent": self.default_agent,
            "workspace": self.workspace,
            "bot_token": self.bot_token,
        }
        # Remove None values for cleaner JSON
        data = {k: v for k, v in data.items() if v is not None}

        # Preserve any top-level keys we don't manage here (e.g. future
        # per-integration configuration blocks). Without this merge, save()
        # would silently drop whatever other components have added to the file.
        if os.path.exists(filepath):
            try:
                with open(filepath, "r") as f:
                    preexisting = json.load(f) or {}
                if isinstance(preexisting, dict):
                    for k, v in preexisting.items():
                        # Only bring forward keys we don't actively manage,
                        # so explicit None-assignment (= "unset") still works.
                        if k not in data and k not in {
                            "default_channel",
                            "default_channel_id",
                            "default_team_id",
                            "default_team_name",
                            "default_team_domain",
                            "default_agent",
                            "workspace",
                            "bot_token",
                        }:
                            data[k] = v
            except (OSError, json.JSONDecodeError):
                pass  # Best effort — fall through and write our fields only.

        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)
        if not quiet:
            print(f"✅ Configuration saved to {filepath}")

    def has_tokens(self) -> bool:
        """Check if bot token is cached in config."""
        return bool(self.bot_token)

    def get_default_channel(self) -> Optional[str]:
        """
        Get the default channel identifier for API calls.
        Prefers channel ID over name since IDs are more reliable.

        Returns:
            Channel ID if available, otherwise channel name, or None
        """
        return self.default_channel_id or self.default_channel

    def get_default_workspace(self) -> Optional[str]:
        """
        Get the default workspace identifier for API calls.
        Prefers team ID over name since IDs are more reliable.

        Returns:
            Team ID if available, otherwise team name, or None
        """
        return self.default_team_id or self.default_team_name


# ============================================================================
# Token Management
# ============================================================================
# This interface ONLY supports Bot Tokens (xoxb-*).
# User tokens (xoxp-*) are NOT supported and will be rejected.
#
# Bot Token (xoxb-*):
#   - Acts as the bot/app itself
#   - Can only access channels where bot is invited
#   - Supports custom username/icon for automated messaging
#   - Scopes are configured in app settings


@dataclass
class SlackTokens:
    """
    Container for Slack authentication tokens.

    Only bot tokens (xoxb-*) are supported. User tokens (xoxp-*) will
    be rejected with an error.

    Attributes:
        bot_token: Bot token (xoxb-*) - acts as the bot/app
    """

    bot_token: Optional[str] = None  # xoxb-* (bot token)


def parse_mcp_tokens(filepath: str = "/dev/shm/mcp-token") -> Dict[str, Any]:
    """
    Parse all tokens from the MCP token file.

    The MCP token file contains credentials for various services in the format:
        ServiceName=value
    or for JSON values:
        ServiceName={"key": "value"}

    Args:
        filepath: Path to MCP token file (default: /dev/shm/mcp-token)

    Returns:
        Dict mapping service names to their token values
    """
    tokens = {}

    try:
        with open(filepath, "r") as f:
            content = f.read()

        for line in content.strip().split("\n"):
            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()

                # Try to parse JSON values (e.g., Slack tokens)
                if value.startswith("{"):
                    try:
                        value = json.loads(value)
                    except json.JSONDecodeError:
                        pass  # Keep as string if not valid JSON

                tokens[key] = value

        return tokens

    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"⚠️ Error parsing tokens: {e}", file=sys.stderr)
        return {}


def _resolve_workspace_identity(
    config: SlackConfig, config_file=AGENT_SETTINGS_PATH
) -> None:
    """Resolve workspace identity (team_id, team_name, team_domain) via event-cache."""
    if config.default_team_id:
        return

    if config.default_channel_id:
        try:
            cache_client = AgentEventCacheClient()
            ws = cache_client.get_workspace(config.default_channel_id)
            config.workspace = ws.name
            if not config.default_team_id:
                config.default_team_id = ws.workspace_id
            config.default_team_name = ws.name
            config.default_team_domain = ws.domain
        except Exception as e:
            logger.warning(f"Could not resolve workspace identity via event-cache: {e}")

    try:
        config.save(config_file, quiet=True)
    except OSError:
        pass


def _setup_workspace(config_file=AGENT_SETTINGS_PATH) -> None:
    """Resolve workspace identity at startup via event-cache (no token needed)."""
    config = SlackConfig.load(config_file)
    _resolve_workspace_identity(config, config_file)


# ============================================================================
# Slack API Client
# ============================================================================
# Low-level client for Slack Web API calls.
# See https://api.slack.com/methods for full API documentation.
#
# Audio/Voice Message Support:
#   Slack messages may contain audio/voice attachments (voice clips, audio files).
#   These appear in the message's 'files' array with mimetype starting with
#   'audio/' (e.g., audio/webm, audio/mp4, audio/ogg) or subtype 'voice_message'.
#
#   When processing messages from the agent-event-cache service,
#   check for audio attachments and transcribe them using the utils transcript API:
#
#       from clients.litellm_client import get_config, api_url
#       cfg = get_config()
#       # 1. Download audio: GET file['url_private_download'] with bot token auth
#       # 2. Transcribe:     POST api_url("/v1/audio/transcriptions")
#       #                    with files={"file": (name, bytes, mimetype)}
#       #                    and data={"model": "ninja-transcribe"}
#       # 3. Use resp.json()["text"] as the message content
#
#   See AGENT_PROTOCOL.md Section 5 for the full audio handling protocol.


class SlackClient:
    """
    Low-level Slack API client with automatic token handling.

    This client provides direct access to Slack Web API methods.
    For higher-level operations, use the SlackInterface class instead.

    Audio/Voice Messages:
        Messages retrieved via the agent-event-cache service may contain
        audio/voice attachments. Check msg['files'] for entries where mimetype
        starts with 'audio/' or subtype is 'voice_message'. Transcribe these
        using the utils transcript API (LiteLLM gateway's
        /v1/audio/transcriptions endpoint). See AGENT_PROTOCOL.md Section 5.

    Attributes:
        tokens: SlackTokens instance with available tokens

    Example:
        client = SlackClient(SlackTokens())
        channels = client.list_channels("")
    """

    BASE_URL = "https://slack.com/api"

    def __init__(self, tokens: SlackTokens):
        """
        Initialize Slack client with tokens.

        Args:
            tokens: SlackTokens instance containing available tokens
        """
        self.tokens = tokens
        self._scopes_cache: Dict[str, List[str]] = {}

    def _get_headers(self, token: str) -> Dict[str, str]:
        """Get HTTP headers for API request with Bearer token auth."""
        return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def _get_headers_multipart(self, token: str) -> Dict[str, str]:
        """Get HTTP headers for multipart/form-data requests (file uploads)."""
        return {
            "Authorization": f"Bearer {token}"
            # Note: Don't set Content-Type for multipart - requests handles it
        }

    def _api_call(
        self,
        method: str,
        token: str,
        params: Optional[Dict] = None,
        max_retries: int = 5,
        base_delay: float = 1.0,
        *,
        allow_refresh: bool = True,
    ) -> Dict:
        """
        Make a Slack API call with automatic retry on rate limiting.

        Args:
            method: API method name (e.g., "chat.postMessage")
            token: Authentication token to use
            params: Optional parameters for the API call
            max_retries: Maximum number of retry attempts (default: 5)
            base_delay: Initial delay in seconds for exponential backoff (default: 1.0)

        Returns:
            API response as dict (always contains 'ok' boolean)

        Retry Behavior:
            - Retries on HTTP 429 (rate limited) with Retry-After header
            - Retries on HTTP 500, 502, 503, 504 (server errors)
            - Retries on Slack API 'ratelimited' error response
            - Retries on connection errors and timeouts
            - Uses exponential backoff: delay = base_delay * (2 ^ attempt)
            - Maximum delay capped at 60 seconds
        """
        url = f"{self.BASE_URL}/{method}"
        headers = self._get_headers(token)
        max_delay = 60.0
        last_exception = None

        for attempt in range(max_retries + 1):
            try:
                if params:
                    response = requests.post(
                        url, headers=headers, json=params, timeout=30
                    )
                else:
                    response = requests.get(url, headers=headers, timeout=30)

                # Check for HTTP 429 rate limiting
                if response.status_code == 429:
                    if attempt < max_retries:
                        retry_after = response.headers.get(
                            "Retry-After", base_delay * (2**attempt)
                        )
                        delay = min(float(retry_after), max_delay)
                        logger.warning(
                            f"API {method}: Rate limited (HTTP 429), retry {attempt + 1}/{max_retries} after {delay:.1f}s"
                        )
                        print(
                            f"[Slack API Rate Limited] {method}: Retry {attempt + 1}/{max_retries} after {delay:.1f}s...",
                            file=sys.stderr,
                        )
                        time.sleep(delay)
                        continue

                # Check for server errors
                if response.status_code in (500, 502, 503, 504):
                    if attempt < max_retries:
                        delay = min(base_delay * (2**attempt), max_delay)
                        print(
                            f"[Slack API Error {response.status_code}] {method}: Retry {attempt + 1}/{max_retries} after {delay:.1f}s...",
                            file=sys.stderr,
                        )
                        time.sleep(delay)
                        continue

                result = response.json()

                # Check for Slack API rate limit error in response body
                if not result.get("ok") and result.get("error") in (
                    "ratelimited",
                    "rate_limited",
                ):
                    if attempt < max_retries:
                        retry_after = result.get(
                            "retry_after", base_delay * (2**attempt)
                        )
                        delay = min(float(retry_after), max_delay)
                        logger.warning(
                            f"API {method}: Rate limited (API response), retry {attempt + 1}/{max_retries} after {delay:.1f}s"
                        )
                        print(
                            f"[Slack API Rate Limited] {method}: Retry {attempt + 1}/{max_retries} after {delay:.1f}s...",
                            file=sys.stderr,
                        )
                        time.sleep(delay)
                        continue

                # Check for token expiration/invalid errors
                if not result.get("ok") and result.get("error") in (
                    "token_expired",
                    "invalid_auth",
                    "token_revoked",
                    "not_authed",
                ):
                    logger.warning(f"API {method}: Token error ({result.get('error')})")

                return result

            except (
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout,
            ) as e:
                last_exception = e
                if attempt < max_retries:
                    delay = min(base_delay * (2**attempt), max_delay)
                    print(
                        f"[Connection Error] {method}: Retry {attempt + 1}/{max_retries} after {delay:.1f}s...",
                        file=sys.stderr,
                    )
                    time.sleep(delay)
                    continue
                logger.error(
                    f"API {method}: Connection error after {max_retries} retries: {str(e)}"
                )
                return {
                    "ok": False,
                    "error": f"Connection error after {max_retries} retries: {str(e)}",
                }

            except requests.RequestException as e:
                logger.error(f"API {method}: Request error: {str(e)}")
                return {"ok": False, "error": str(e)}

        # If we've exhausted all retries
        if last_exception:
            logger.error(
                f"API {method}: Failed after {max_retries} retries: {str(last_exception)}"
            )
            return {
                "ok": False,
                "error": f"Failed after {max_retries} retries: {str(last_exception)}",
            }
        return {"ok": False, "error": f"Failed after {max_retries} retries"}

    def test_auth(self, token: str, *, allow_refresh: bool = True) -> Dict:
        """
        Test authentication and get token info.

        API Method: auth.test
        Required Scopes: None (works with any valid token)

        Args:
            token: Token to test
            allow_refresh: When False, return token errors without refreshing
                (used by the health check to detect stale in-memory tokens).

        Returns:
            Dict with 'ok', 'user', 'team', 'url' on success
        """
        return self._api_call("auth.test", token, allow_refresh=allow_refresh)

    def get_user(self, token: str, user_id: str) -> Dict:
        """
        Fetch a single user profile.

        API Method: users.info
        Required Scopes: users:read
        """
        return self._api_call("users.info", token, {"user": user_id})

    def get_scopes(self, token: str) -> List[str]:
        """
        Get available OAuth scopes for a token.

        Scopes are returned in the x-oauth-scopes response header.
        Results are cached to avoid repeated API calls.

        Args:
            token: Token to check scopes for

        Returns:
            List of scope strings (e.g., ["chat:write", "channels:read"])
        """
        if token in self._scopes_cache:
            return self._scopes_cache[token]

        url = f"{self.BASE_URL}/auth.test"
        headers = self._get_headers(token)

        try:
            response = requests.get(url, headers=headers, timeout=30)
            scopes_header = response.headers.get("x-oauth-scopes", "")
            scopes = [s.strip() for s in scopes_header.split(",") if s.strip()]
            self._scopes_cache[token] = scopes
            return scopes
        except:
            return []

    def list_channels(
        self,
        token: str,
        types: str = "public_channel,private_channel",
        limit: int = 200,
    ) -> List[Dict]:
        """List all channels via agent-event-cache (no Slack API fallback)."""
        cache_client = AgentEventCacheClient()
        response = cache_client.get_channels()
        channels = []
        for ch in response.channels:
            channels.append(
                {
                    "id": ch.channel_id,
                    "name": ch.name or "",
                    "is_private": ch.is_private,
                    "is_archived": ch.is_archived,
                    "topic": {"value": ch.topic or ""},
                    "purpose": {"value": ch.purpose or ""},
                }
            )
        return channels

    def list_users(
        self,
        token: str,
        limit: int = 200,
        use_cache: bool = True,
        channel_id: Optional[str] = None,
    ) -> List[Dict]:
        """List channel members via agent-event-cache (no Slack API fallback)."""
        if not channel_id:
            return []
        cache_client = AgentEventCacheClient()
        response = cache_client.get_channel_members(channel_id)
        users = []
        for member in response.members:
            users.append(
                {
                    "id": member.user_id,
                    "name": member.user_name or "",
                    "real_name": member.real_name or "",
                    "is_bot": member.is_bot or False,
                    "deleted": member.is_deleted or False,
                }
            )
        return users

    def get_channel_history(
        self, token: str, workspace: str, channel: str, limit: int = 50
    ) -> List[Dict]:
        """
        Get message history from a channel via the agent-event-cache service.

        Args:
            token: Unused — kept for API compatibility.
            channel: Channel ID (e.g., "C0AAAAMBR1R")
            limit: Number of messages to return

        Returns:
            List of message dicts with 'text', 'user', 'ts', etc.
            Messages are in reverse chronological order (newest first)

        Raises:
            requests.HTTPError: On 4xx/5xx responses (403 = unauthorized,
                never treated as an empty channel).
        """
        request = GetMessagesRequest(
            channel_id=channel, workspace_id=workspace, limit=limit
        )
        return AgentEventCacheClient().get_messages(request).messages

    def get_thread_replies(
        self, token: str, workspace: str, channel: str, thread_ts: str, limit: int = 50
    ) -> List[Dict]:
        """
        Get replies to a thread via the agent-event-cache service.

        Args:
            token: Unused — kept for API compatibility.
            channel: Channel ID (e.g., "C0AAAAMBR1R")
            thread_ts: Timestamp of the parent message
            limit: Number of replies to retrieve

        Returns:
            List of message dicts including parent and all replies.
            First message is the parent, rest are replies in chronological order.

        Raises:
            requests.HTTPError: On 4xx/5xx responses (403 = unauthorized,
                never treated as an empty thread).
        """
        request = GetMessagesRequest(
            channel_id=channel,
            workspace_id=workspace,
            thread_ts=thread_ts,
            limit=limit,
        )
        return AgentEventCacheClient().get_messages(request).messages

    def add_reaction(
        self, token: str, channel: str, timestamp: str, emoji: str
    ) -> bool:
        """
        Add an emoji reaction to a message via the Slack reactions.add API.

        Args:
            token: Bot token with reactions:write scope
            channel: Channel ID containing the message
            timestamp: Message timestamp (ts) to react to
            emoji: Emoji name without colons (e.g. "ghost", "eyes", "+1")

        Returns:
            True if the reaction was added successfully, False otherwise
            (already_reacted is treated as success — idempotent).
        """
        payload = {
            "channel": channel,
            "timestamp": timestamp,
            "name": emoji,
        }
        result = self._api_call("reactions.add", token, payload)
        if result.get("ok"):
            return True
        # already_reacted is fine — we just want the reaction there
        if result.get("error") == "already_reacted":
            return True
        logger.warning(
            "reactions.add failed",
            extra={
                "error": result.get("error"),
                "channel": channel,
                "ts": timestamp,
            },
        )
        return False

    def send_message(
        self,
        token: str,
        channel: str,
        text: str,
        thread_ts: Optional[str] = None,
        username: Optional[str] = None,
        icon_emoji: Optional[str] = None,
        icon_url: Optional[str] = None,
        convert_markdown: bool = True,
        blocks: Optional[List[Dict]] = None,
        unfurl_links: Optional[bool] = None,
        unfurl_media: Optional[bool] = None,
        auto_blocks_for_tables: bool = True,
    ) -> Dict:
        """
        Send a message to a channel.

        API Method: chat.postMessage
        Required Scopes: chat:write

        Note: username, icon_emoji, and icon_url only work with bot tokens
        and require chat:write.customize scope for full customization.

        Args:
            token: Authentication token (bot token preferred for custom identity)
            channel: Channel ID or name
            text: Message text (supports Markdown - auto-converted to Slack mrkdwn)
                  Also serves as fallback text when blocks are provided.
            thread_ts: Thread timestamp for replies (optional)
            username: Custom bot username (optional, bot token only)
            icon_emoji: Custom emoji icon like ":robot_face:" (optional)
            icon_url: Custom icon image URL (optional, overrides icon_emoji)
            convert_markdown: If True, convert standard Markdown to Slack mrkdwn (default: True)
            blocks: List of Block Kit block dicts for rich layouts (optional)
                    See: https://api.slack.com/block-kit
            auto_blocks_for_tables: If True (default) and no explicit `blocks`
                    are supplied, Markdown containing tables/headers/dividers/
                    fenced code is promoted to Block Kit blocks so Slack renders
                    tables natively. Set False to force the plain mrkdwn path.

        Returns:
            API response with 'ok', 'ts' (timestamp), 'channel' on success

        Note:
            Markdown conversion handles:
            - **bold** -> *bold*
            - *italic* -> _italic_
            - [text](url) -> <url|text>
            - # Heading -> *Heading* (bold)
            - - item -> bullet item

            Tables in Markdown are auto-promoted to a Block Kit `markdown`
            block (Slack renders them as real tables). Disable with
            auto_blocks_for_tables=False to fall back to raw passthrough.

        Block Kit Examples:
            Radio buttons, checkboxes, buttons, select menus can be sent via blocks.
            See send_poll() for a convenient wrapper for multiple choice questions.
        """
        # Convert standard Markdown to Slack mrkdwn format
        # Convert 0.0.0.0:<port> to public sandbox URLs
        text = convert_sandbox_urls(text)

        if convert_markdown:
            # If the caller did not supply blocks, auto-conversion is enabled,
            # and the text contains a markdown table/header/divider/code-block,
            # promote to Block Kit (markdown blocks render tables natively).
            # Otherwise fall back to the plain slackify_markdown path.
            if (
                blocks is None
                and auto_blocks_for_tables
                and md_to_slack_blocks is not None
            ):
                auto_blocks, fallback = md_to_slack_blocks(text)
                if auto_blocks:
                    blocks = auto_blocks
                    text = fallback  # notification preview only
                else:
                    text = slackify_markdown(text)
            else:
                text = slackify_markdown(text)

        params = {"channel": channel, "text": text}
        if thread_ts:
            params["thread_ts"] = thread_ts

        # Custom bot appearance (only works with bot tokens)
        if username:
            params["username"] = username
        if icon_emoji:
            params["icon_emoji"] = icon_emoji
        if icon_url:
            params["icon_url"] = icon_url

        # Block Kit blocks for rich layouts
        if blocks:
            params["blocks"] = blocks

        # Unfurl controls — required for the permalink-as-attachment flow
        # used by upload_file(). Slack's default for bot messages is to
        # suppress unfurls unless explicitly enabled.
        if unfurl_links is not None:
            params["unfurl_links"] = bool(unfurl_links)
        if unfurl_media is not None:
            params["unfurl_media"] = bool(unfurl_media)

        # Log intent before the API call
        sender = username or "bot"
        preview = text[:200] + ("..." if len(text) > 200 else "")
        logger.info(f"MSG SENDING [{sender} → {channel}]: {preview}")

        result = self._api_call("chat.postMessage", token, params)

        # Log outcome
        if result.get("ok"):
            logger.info(f"MSG SENT [{sender} → {channel}] ts={result.get('ts')}")
        else:
            logger.error(
                f"MSG FAIL [{sender} → {channel}]: {result.get('error', 'unknown')}"
            )

        return result

    def upload_file_v2(
        self,
        token: str,
        channel: Optional[str] = None,
        file_path: Optional[str] = None,
        content: Optional[str] = None,
        filename: Optional[str] = None,
        title: Optional[str] = None,
        initial_comment: Optional[str] = None,
        thread_ts: Optional[str] = None,
        snippet_type: Optional[str] = None,
    ) -> Dict:
        """
        Upload a file to Slack using the newer files.uploadV2 API.

        This is the recommended method for file uploads as files.upload is deprecated.
        The V2 API uses a three-step process:
        1. Get an upload URL from Slack (files.getUploadURLExternal)
        2. Upload the file content to that URL
        3. Complete the upload (files.completeUploadExternal). When
           `channel` is provided the file is shared into that channel on
           completion; when `channel` is None the file is stored in Slack
           but not posted anywhere — the caller is then free to share it
           later (e.g. by posting its permalink from `get_file_info`).

        API Methods: files.getUploadURLExternal, files.completeUploadExternal
        Required Scopes: files:write

        Retry Behavior:
            - Retries on HTTP 429 (rate limited) with exponential backoff
            - Retries on connection errors and timeouts
            - Maximum 5 retries per step with up to 60s delay

        Args:
            token: Authentication token with files:write scope
            channel: Channel ID to share file to (must be ID, not name).
                     Pass None to upload WITHOUT sharing to any channel —
                     useful when the caller wants to post the file's
                     permalink itself (e.g. as a specific agent identity).
            file_path: Path to file on disk (optional if content provided)
            content: File content as string/bytes (optional if file_path provided)
            filename: Filename to display in Slack (required if content provided)
            title: Title for the file (optional, defaults to filename)
            initial_comment: Message to post with the file (optional)
            thread_ts: Thread timestamp to post file as reply (optional)
            snippet_type: For text content, the syntax highlighting type (optional)

        Returns:
            API response with 'ok', 'files' array on success

        Example:
            # Upload and share to a channel
            result = client.upload_file_v2(token, "C123456", file_path="report.pdf")

            # Upload without sharing (caller shares the permalink later)
            result = client.upload_file_v2(token, channel=None, file_path="report.pdf")

            # Upload text content
            result = client.upload_file_v2(token, "C123456",
                                           content="print('hello')",
                                           filename="script.py",
                                           snippet_type="python")
        """
        max_retries = 5
        base_delay = 1.0
        max_delay = 60.0

        def _request_with_retry(
            method: str, url: str, step_name: str, **kwargs
        ) -> requests.Response:
            """Helper to make requests with retry logic."""
            for attempt in range(max_retries + 1):
                try:
                    if method == "post":
                        response = requests.post(url, **kwargs)
                    else:
                        response = requests.get(url, **kwargs)

                    # Check for rate limiting
                    if response.status_code == 429:
                        if attempt < max_retries:
                            retry_after = response.headers.get(
                                "Retry-After", base_delay * (2**attempt)
                            )
                            delay = min(float(retry_after), max_delay)
                            print(
                                f"[Rate Limited] {step_name}: Retry {attempt + 1}/{max_retries} after {delay:.1f}s...",
                                file=sys.stderr,
                            )
                            time.sleep(delay)
                            continue

                    # Check for server errors
                    if response.status_code in (500, 502, 503, 504):
                        if attempt < max_retries:
                            delay = min(base_delay * (2**attempt), max_delay)
                            print(
                                f"[Server Error {response.status_code}] {step_name}: Retry {attempt + 1}/{max_retries} after {delay:.1f}s...",
                                file=sys.stderr,
                            )
                            time.sleep(delay)
                            continue

                    return response

                except (
                    requests.exceptions.ConnectionError,
                    requests.exceptions.Timeout,
                ) as e:
                    if attempt < max_retries:
                        delay = min(base_delay * (2**attempt), max_delay)
                        print(
                            f"[Connection Error] {step_name}: Retry {attempt + 1}/{max_retries} after {delay:.1f}s...",
                            file=sys.stderr,
                        )
                        time.sleep(delay)
                        continue
                    raise

            return response

        try:
            # Determine file content and metadata
            if file_path:
                path = Path(file_path)
                if not path.exists():
                    return {"ok": False, "error": f"File not found: {file_path}"}

                file_content = path.read_bytes()
                file_size = len(file_content)
                actual_filename = filename or path.name
            elif content:
                if isinstance(content, str):
                    file_content = content.encode("utf-8")
                else:
                    file_content = content
                file_size = len(file_content)
                actual_filename = filename or "untitled"
            else:
                return {
                    "ok": False,
                    "error": "Either file_path or content must be provided",
                }

            actual_title = title or actual_filename

            # Step 1: Get upload URL (uses form data, not JSON)
            get_url_data = {"filename": actual_filename, "length": file_size}
            if snippet_type:
                get_url_data["snippet_type"] = snippet_type

            headers = {"Authorization": f"Bearer {token}"}
            url_response = _request_with_retry(
                "post",
                f"{self.BASE_URL}/files.getUploadURLExternal",
                "files.getUploadURLExternal",
                headers=headers,
                data=get_url_data,
                timeout=30,
            )

            url_response_json = url_response.json()

            # Check for rate limit in response body
            if not url_response_json.get("ok"):
                if url_response_json.get("error") in ("ratelimited", "rate_limited"):
                    # Already retried in _request_with_retry, return error
                    pass
                return url_response_json

            upload_url = url_response_json.get("upload_url")
            file_id = url_response_json.get("file_id")

            if not upload_url or not file_id:
                return {"ok": False, "error": "Failed to get upload URL from Slack"}

            # Step 2: Upload file content to the URL
            upload_response = _request_with_retry(
                "post",
                upload_url,
                "file upload",
                data=file_content,
                headers={"Content-Type": "application/octet-stream"},
                timeout=120,
            )

            if upload_response.status_code != 200:
                return {
                    "ok": False,
                    "error": f"Upload failed with status {upload_response.status_code}",
                }

            # Step 3: Complete the upload and optionally share to channel (uses form data)
            complete_data = {
                "files": json.dumps([{"id": file_id, "title": actual_title}])
            }

            if channel:
                complete_data["channel_id"] = channel
            if initial_comment:
                complete_data["initial_comment"] = initial_comment
            if thread_ts:
                complete_data["thread_ts"] = thread_ts

            complete_response = _request_with_retry(
                "post",
                f"{self.BASE_URL}/files.completeUploadExternal",
                "files.completeUploadExternal",
                headers=headers,
                data=complete_data,
                timeout=30,
            )

            return complete_response.json()

        except requests.RequestException as e:
            return {"ok": False, "error": f"Request failed: {str(e)}"}
        except Exception as e:
            return {"ok": False, "error": f"Upload failed: {str(e)}"}

    def get_file_info(self, token: str, file_id: str) -> Dict:
        """
        Get information about an uploaded file.

        API Method: files.info
        Required Scopes: files:read

        Args:
            token: Authentication token
            file_id: The file ID to get info for

        Returns:
            API response with 'ok' and 'file' dict containing permalink, url_private, etc.
        """
        return self._api_call("files.info", token, {"file": file_id})

    def get_channel_info(self, token: str, channel: str) -> Dict:
        """
        Get information about a channel.

        Fetches from agent-event-cache service (GET /db/channel-info) when
        available, falling back to Slack API (conversations.info) otherwise.

        Args:
            token: Authentication token
            channel: Channel ID

        Returns:
            API response with 'ok', 'channel' object on success
        """
        # Try agent-event-cache first
        try:
            cache_client = AgentEventCacheClient()
            print(
                f"[slack-cache] GET /db/channel-info?channel_id={channel} via agent-event-cache",
                flush=True,
            )
            info = cache_client.get_channel_info(channel)
            # Return in Slack-compatible format
            return {
                "ok": True,
                "channel": {
                    "id": info.channel_id,
                    "name": info.name or "",
                    "is_private": info.is_private,
                    "is_archived": info.is_archived,
                    "topic": {"value": info.topic or ""},
                    "purpose": {"value": info.purpose or ""},
                },
            }
        except Exception as e:
            logging.warning(
                f"agent-event-cache get_channel_info failed for "
                f"{channel}, falling back to Slack API: {e}"
            )

        # Fallback: Slack API
        url = f"{self.BASE_URL}/conversations.info"
        headers = self._get_headers(token)
        params = {"channel": channel}

        try:
            response = requests.get(url, headers=headers, params=params, timeout=30)
            return response.json()
        except requests.RequestException as e:
            print(f"❌ Error: {e}", file=sys.stderr)
            return {"ok": False, "error": str(e)}

    def join_channel(self, token: str, channel: str) -> Dict:
        """
        Join a channel.

        API Method: conversations.join
        Required Scopes: channels:join

        Note: Bots can only join public channels. For private channels,
        the bot must be invited by a channel member.

        Args:
            token: Authentication token
            channel: Channel ID to join

        Returns:
            API response with 'ok', 'channel' object on success
        """
        params = {"channel": channel}
        return self._api_call("conversations.join", token, params)

    def create_channel(self, token: str, name: str, is_private: bool = False) -> Dict:
        """
        Create a new channel.

        API Method: conversations.create
        Required Scopes: channels:manage (public), groups:write (private)

        Args:
            token: Authentication token
            name: Channel name (lowercase, no spaces, max 80 chars)
            is_private: Create as private channel (default: False)

        Returns:
            API response with 'ok', 'channel' object on success
        """
        params = {"name": name, "is_private": is_private}
        return self._api_call("conversations.create", token, params)


# ============================================================================
# CLI Commands
# ============================================================================
# Each cmd_* function implements a CLI subcommand.
# Functions receive the client, tokens, and parsed args.


def cmd_agents(client: SlackClient, tokens: SlackTokens, args) -> None:
    """List all available agents with their avatars."""
    print("\n" + "=" * 60)
    print("🤖 AVAILABLE AGENTS")
    print("=" * 60)

    for agent_id, info in AGENT_AVATARS.items():
        print(f"\n{info['emoji']} {info['name']} ({agent_id})")
        print(f"   Role: {info['role']}")
        print(f"   Color: {info['color']}")
        print(f"   Avatar: {info['icon_url']}")

    print("\n" + "-" * 60)
    print("💡 Usage:")
    print("   python slack_interface.py say -a nova 'Hello from Nova!'")
    print("   python slack_interface.py say -a pixel 'Design ready!'")
    print("   python slack_interface.py say -a bolt 'Code deployed!'")
    print("   python slack_interface.py say -a scout 'Tests passed!'")
    print("=" * 60 + "\n")


def cmd_config(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Show or set configuration."""
    config = SlackConfig.load(args.config_file)

    # Set default channel
    if hasattr(args, "set_channel") and args.set_channel:
        channel = args.set_channel

        # If channel ID was provided directly, skip the API lookup entirely
        explicit_id = getattr(args, "set_channel_id", None)
        if explicit_id:
            config.default_channel = channel
            config.default_channel_id = explicit_id
            print(f"✅ Channel configured: {channel} (ID: {explicit_id})")
        elif channel.startswith("#"):
            # Try to resolve channel ID via API
            # Unreliable as this runs into rate limits
            token = tokens.bot_token
            if token:
                channels = client.list_channels(token)
                channel_name = channel[1:]  # Remove #
                for ch in channels:
                    if ch.get("name") == channel_name:
                        config.default_channel = channel
                        config.default_channel_id = ch.get("id")
                        print(
                            f"✅ Found channel: {channel} (ID: {config.default_channel_id})"
                        )
                        break
                else:
                    print(f"⚠️ Channel {channel} not found, saving name only")
                    config.default_channel = channel
                    config.default_channel_id = None
            else:
                config.default_channel = channel
        else:
            # Assume it's a channel ID
            config.default_channel_id = channel

        config.save(args.config_file)
        return

    # Set workspace ID
    if hasattr(args, "set_workspace_id") and args.set_workspace_id:
        config.default_team_id = args.set_workspace_id
        config.save(args.config_file)
        print(f"✅ Workspace ID set to: {args.set_workspace_id}")
        return

    # Set default agent
    if hasattr(args, "set_agent") and args.set_agent:
        agent = args.set_agent.lower()
        if agent not in AGENT_AVATARS:
            print(f"❌ Invalid agent: {agent}", file=sys.stderr)
            print(
                f"   Valid agents: {', '.join(AGENT_AVATARS.keys())}", file=sys.stderr
            )
            sys.exit(1)

        config.default_agent = agent
        agent_info = AGENT_AVATARS[agent]
        print(f"✅ Default agent set to: {agent_info['name']} ({agent_info['role']})")
        config.save(args.config_file)
        return

    # Show current configuration
    print("\n" + "=" * 60)
    print("⚙️  SLACK INTERFACE CONFIGURATION")
    print("=" * 60)
    print(f"\n📁 Config file: {args.config_file}")
    print(f"\n📋 Current Settings:")
    print(f"   Default Channel: {config.default_channel or '(not set)'}")
    print(f"   Default Channel ID: {config.default_channel_id or '(not set)'}")
    if config.default_agent:
        agent_info = AGENT_AVATARS.get(config.default_agent, {})
        print(
            f"   Default Agent: {config.default_agent} ({agent_info.get('name', '')} - {agent_info.get('role', '')})"
        )
    else:
        print(f"   Default Agent: (not set)")
    print(f"   Workspace: {config.workspace or '(not set)'}")

    print(f"\n💡 Configuration Commands:")
    print(f"   python slack_interface.py config --set-channel '#channel-name'")
    print(f"   python slack_interface.py config --set-agent nova")
    print(f"\n🤖 Available Agents: {', '.join(AGENT_AVATARS.keys())}")
    print("=" * 60 + "\n")


def cmd_say(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Send a message to the default channel as the configured agent (via event-cache)."""
    config = SlackConfig.load(args.config_file)

    # Use -a flag if provided, otherwise fall back to config default
    agent = (
        args.agent.lower()
        if hasattr(args, "agent") and args.agent
        else config.default_agent.lower() if config.default_agent else None
    )

    if not agent:
        print("❌ No default agent configured", file=sys.stderr)
        print("\n🤖 The 'say' command requires an agent identity.", file=sys.stderr)
        print("\n💡 First, set your default agent:", file=sys.stderr)
        print("   python slack_interface.py config --set-agent nova", file=sys.stderr)
        print(
            f"\n🤖 Available agents: {', '.join(AGENT_AVATARS.keys())}", file=sys.stderr
        )
        sys.exit(1)

    # Validate agent
    if agent not in AGENT_AVATARS:
        print(f"❌ Invalid agent in config: {agent}", file=sys.stderr)
        print(f"\n💡 Set a valid agent:", file=sys.stderr)
        print(f"   python slack_interface.py config --set-agent nova", file=sys.stderr)
        print(f"\n🤖 Valid agents: {', '.join(AGENT_AVATARS.keys())}", file=sys.stderr)
        sys.exit(1)

    message = args.message
    thread = resolve_reply_thread(args.thread if hasattr(args, "thread") else None)

    agent_info = get_agent_avatar(agent)
    username = agent_info["name"]

    # Show which channel we're sending to
    channel = config.get_default_channel()
    channel_display = (
        channel if channel and channel.startswith("#") else f"ID:{channel}"
    )
    print(f"\n📤 Sending to {channel_display}...")
    print(f"   As: {username} ({agent_info['role']})")

    iface = SlackInterface(args.config_file)
    try:
        result = iface.say(
            message,
            thread_ts=thread,
            agent=agent,
        )
    except Exception as e:
        print(f"❌ Failed to send: {e}", file=sys.stderr)
        logger.error(f"MSG FAILED as {username} to {channel_display}: {e}")
        sys.exit(1)

    print(f"✅ Message sent successfully!")
    print(f"   Channel: {result.get('channel')}")
    print(f"   Timestamp: {result.get('ts')}")
    preview = message[:200] + ("..." if len(message) > 200 else "")
    logger.info(f"MSG SENT as {username} to {channel_display}: {preview}")
    # Best-effort: never let cleanup fail a message we already delivered.
    try:
        clear_live_progress()
    except Exception as e:
        logger.warning(f"Live progress cleanup after say failed: {e}")
    publish_message_handled(
        config.default_team_id,
        result.get("channel"),
        thread,
        result.get("ts"),
    )


def cmd_read(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Read messages from the default channel."""
    config = SlackConfig.load(args.config_file)

    # Determine channel: CLI arg > config default
    channel = None
    if hasattr(args, "channel") and args.channel:
        channel = args.channel
    else:
        channel = config.get_default_channel()

    workspace = None
    if hasattr(args, "workspace") and args.workspace:
        workspace = args.workspace
    else:
        workspace = config.get_default_workspace()

    if not channel:
        print(
            "❌ No channel specified and no default channel configured", file=sys.stderr
        )
        print("\n💡 To set a default channel:", file=sys.stderr)
        print(
            "   python slack_interface.py config --set-channel '#channel-name'",
            file=sys.stderr,
        )
        print("\n   Or specify channel with -c:", file=sys.stderr)
        print("   python slack_interface.py read -c '#channel'", file=sys.stderr)
        sys.exit(1)

    # Use bot token for reading (has channels:history scope)
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        sys.exit(1)

    limit = args.limit if hasattr(args, "limit") else 50

    # Show which channel we're reading from
    channel_display = channel if channel.startswith("#") else f"ID:{channel}"
    print(f"\n📖 Reading messages from {channel_display}...")

    messages = client.get_channel_history(token, workspace, channel, limit)

    if not messages:
        print("📭 No messages found or channel is empty")
        print("\n💡 Troubleshooting:")
        print(
            "   • 'missing_scope' error: Add 'channels:history' scope to your Slack app"
        )
        print("   • 'not_in_channel' error: Invite the bot to the channel first:")
        print("     → Go to the channel in Slack and type: /invite @superninja")
        print(
            "   • Or add 'channels:join' scope to allow the bot to join automatically"
        )
        return

    print(f"\n💬 Last {len(messages)} messages:\n")
    print("=" * 80)

    # Build user cache from message data only (no extra API call)
    # This avoids the expensive users.list API call which can be rate limited
    # and makes multiple paginated requests for large workspaces
    users_cache = {}
    for msg in messages:
        user_id = msg.get("user")
        if user_id and user_id not in users_cache:
            # Try to get username from message metadata if available
            if msg.get("user_profile"):
                profile = msg.get("user_profile")
                users_cache[user_id] = (
                    profile.get("real_name")
                    or profile.get("display_name")
                    or profile.get("name")
                    or user_id
                )
            elif msg.get("username"):
                users_cache[user_id] = msg.get("username")

    for msg in reversed(messages):
        user_id = msg.get("user", "unknown")
        user_name = users_cache.get(user_id, user_id)
        text = msg.get("text", "")
        ts = msg.get("ts", "")

        # Check for bot messages with custom username
        if msg.get("bot_id") and msg.get("username"):
            user_name = msg.get("username")

        # Convert timestamp
        try:
            dt = datetime.fromtimestamp(float(ts))
            time_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        except:
            time_str = ts

        # The id to pass to `say -t` to answer this message in its own thread.
        reply_to = msg.get("thread_ts") or ts

        # ----------------------------------------------------------------
        # File/Attachment Detection (audio, images, documents)
        # ----------------------------------------------------------------
        # Slack file attachments appear in the 'files' array with:
        #   - mimetype starting with 'audio/'  → voice/audio message
        #   - mimetype starting with 'image/'  → PNG, JPEG, GIF, etc.
        #   - mimetype == 'application/pdf'    → PDF document
        #   - any other mimetype               → generic file
        #
        # All file types expose:
        #   file['name']                 → original filename
        #   file['mimetype']             → MIME type
        #   file['size']                 → size in bytes
        #   file['url_private_download'] → authenticated download URL (requires bot token)
        #
        # Audio handling:
        #   1. Download via file['url_private_download'] with bot token auth header
        #   2. Transcribe via the utils transcript API:
        #        from clients.litellm_client import get_config, api_url
        #        resp = requests.post(
        #            api_url("/v1/audio/transcriptions"),
        #            headers={"Authorization": f"Bearer {cfg['api_key']}"},
        #            files={"file": (name, audio_bytes, mimetype)},
        #            data={"model": "ninja-transcribe"}
        #        )
        #        transcript = resp.json().get("text", "")
        #   3. Use transcript text as the message content for processing
        #
        # See AGENT_PROTOCOL.md Section 5 for the full audio handling protocol.
        # ----------------------------------------------------------------
        has_audio = False
        image_files = []
        pdf_files = []
        other_files = []
        files = msg.get("files", [])
        for f in files:
            mimetype = f.get("mimetype", "")
            subtype = f.get("subtype", "")
            name = f.get("name", "unknown")
            size = f.get("size", 0)
            url = f.get("url_private_download", "")
            if mimetype.startswith("audio/") or subtype == "voice_message":
                has_audio = True
            elif mimetype.startswith("image/"):
                image_files.append(
                    {"name": name, "mimetype": mimetype, "size": size, "url": url}
                )
            elif mimetype == "application/pdf":
                pdf_files.append(
                    {"name": name, "mimetype": mimetype, "size": size, "url": url}
                )
            elif mimetype:
                other_files.append(
                    {"name": name, "mimetype": mimetype, "size": size, "url": url}
                )

        # Format output
        header = f"┌─ {user_name} [{time_str}]"
        if reply_to:
            header += f"  reply-to: {reply_to}"
        print(header)

        # Flag audio/voice messages so agents know to transcribe them
        if has_audio:
            print(
                f"│  🎤 [Voice/Audio Message — transcribe using utils transcript API]"
            )

        # Flag image attachments
        for img in image_files:
            size_kb = img["size"] // 1024
            print(f"│  🖼️  [Image: {img['name']} ({img['mimetype']}, {size_kb} KB)]")
            print(f"│      URL: {img['url']}")

        # Flag PDF attachments
        for pdf in pdf_files:
            size_kb = pdf["size"] // 1024
            print(f"│  📄 [PDF: {pdf['name']} ({size_kb} KB)]")
            print(f"│      URL: {pdf['url']}")

        # Flag other file attachments
        for of in other_files:
            size_kb = of["size"] // 1024
            print(f"│  📎 [File: {of['name']} ({of['mimetype']}, {size_kb} KB)]")
            print(f"│      URL: {of['url']}")

        # Handle multi-line messages
        for line in text.split("\n"):
            print(f"│  {line}")

        print("└" + "─" * 79)

    print(f"\n📊 Total: {len(messages)} messages from {channel_display}")
    logger.info(f"READ {len(messages)} messages from {channel_display}")


def cmd_upload(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Upload a file to a channel as the configured agent identity."""
    config = SlackConfig.load(args.config_file)

    # Determine channel: CLI arg > config default
    channel = (
        args.channel
        if hasattr(args, "channel") and args.channel
        else config.get_default_channel()
    )

    if not channel:
        print(
            "❌ No channel specified and no default channel configured", file=sys.stderr
        )
        print("\n💡 To set a default channel:", file=sys.stderr)
        print(
            "   python slack_interface.py config --set-channel '#channel-name'",
            file=sys.stderr,
        )
        print("\n   Or specify channel with -c:", file=sys.stderr)
        print(
            "   python slack_interface.py upload file.png -c '#channel'",
            file=sys.stderr,
        )
        sys.exit(1)

    # The configured agent identity is REQUIRED — every CLI command posts as
    # that agent. This is set once via:
    #   python slack_interface.py config --set-agent <agent>
    agent = config.default_agent.lower() if config.default_agent else None
    if not agent:
        print("❌ No default agent configured", file=sys.stderr)
        print(
            "\n🤖 The 'upload' command posts files as the configured agent.",
            file=sys.stderr,
        )
        print("\n💡 First, set your default agent:", file=sys.stderr)
        print("   python slack_interface.py config --set-agent ninja", file=sys.stderr)
        print(
            f"\n🤖 Available agents: {', '.join(AGENT_AVATARS.keys())}", file=sys.stderr
        )
        sys.exit(1)

    if agent not in AGENT_AVATARS:
        print(f"❌ Invalid agent in config: {agent}", file=sys.stderr)
        print(f"\n💡 Set a valid agent:", file=sys.stderr)
        print(f"   python slack_interface.py config --set-agent ninja", file=sys.stderr)
        print(f"\n🤖 Valid agents: {', '.join(AGENT_AVATARS.keys())}", file=sys.stderr)
        sys.exit(1)

    file_path = args.file
    title = args.title if hasattr(args, "title") and args.title else None
    comment = args.message if hasattr(args, "message") and args.message else None
    thread = resolve_reply_thread(
        args.thread if hasattr(args, "thread") and args.thread else None
    )

    slack = SlackInterface(args.config_file)

    agent_info = get_agent_avatar(agent)
    channel_display = channel if channel.startswith("#") else f"ID:{channel}"
    print(f"\n📤 Uploading to {channel_display}...")
    print(f"   File: {file_path}")
    print(f"   As: {agent_info['name']} ({agent_info['role']})")
    print(f"   Avatar: {agent_info['emoji']} Custom image")
    if title:
        print(f"   Title: {title}")
    if comment:
        print(f"   Comment: {comment[:50]}{'...' if len(comment) > 50 else ''}")

    try:
        result = slack.upload_file(
            file_path=file_path,
            channel=channel,
            title=title,
            comment=comment,
            thread_ts=thread,
            agent=agent,
        )
    except (ValueError, RuntimeError) as e:
        print(f"❌ Failed to upload: {e}", file=sys.stderr)
        logger.error(f"UPLOAD FAILED: {file_path} to {channel_display}: {e}")
        sys.exit(1)

    if result.get("ok"):
        file_info = result.get("file") or {}
        print(f"✅ File uploaded to {channel_display}")
        if agent_info:
            print(f"   Identity: {agent_info['name']} (configured agent)")
        if file_info.get("id"):
            print(f"   File ID: {file_info.get('id')}")
        if file_info.get("title"):
            print(f"   Title: {file_info.get('title')}")
        if result.get("permalink"):
            print(f"   Permalink: {result['permalink']}")
        if result.get("message_ts"):
            print(f"   Message ts: {result['message_ts']}")
        logger.info(
            f"UPLOAD OK as {agent_info['name']}: {file_path} to {channel_display}"
        )
        # A delivered file is an answer too, so the checklist is done. Same
        # best-effort rule as cmd_say: never fail an upload that landed.
        try:
            clear_live_progress()
        except Exception as e:
            logger.warning(f"Live progress cleanup after upload failed: {e}")
        publish_message_handled(
            config.default_team_id,
            result.get("channel_id"),
            thread,
            result.get("message_ts"),
        )
    else:
        error = (
            result.get("upload_error") or result.get("message_error") or "Unknown error"
        )
        print(f"❌ Failed to upload: {error}", file=sys.stderr)
        logger.error(f"UPLOAD FAILED: {file_path} to {channel_display}: {error}")
        if error == "missing_scope":
            print(
                "\n💡 The 'files:write' scope is required for file uploads.",
                file=sys.stderr,
            )
            print(
                "   Add this scope to your Slack app at: https://api.slack.com/apps",
                file=sys.stderr,
            )
        elif error == "channel_not_found":
            print(
                "\n💡 Channel not found. Make sure the bot is a member of the channel.",
                file=sys.stderr,
            )
        sys.exit(1)


def cmd_react(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Add an emoji reaction to a message (via event-cache)."""
    _run_reaction(args, remove=False)


def cmd_unreact(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Remove the agent's emoji reaction from a message (via event-cache)."""
    _run_reaction(args, remove=True)


def _run_reaction(args, *, remove: bool) -> None:
    """Shared body of cmd_react/cmd_unreact."""
    verb = "unreact" if remove else "react"
    iface = SlackInterface(args.config_file)
    try:
        action = iface.unreact if remove else iface.react
        ok = action(args.ts, args.emoji, channel=args.channel)
    except Exception as e:
        print(f"❌ Failed to {verb}: {e}", file=sys.stderr)
        logger.error(f"{verb.upper()} FAILED [{args.emoji}] ts={args.ts}: {e}")
        sys.exit(1)

    if not ok:
        print(f"❌ Failed to {verb}: no channel or workspace resolved", file=sys.stderr)
        print("\n💡 Set a default channel or pass -c:", file=sys.stderr)
        print(
            "   python slack_interface.py config --set-channel '#channel-name'",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"✅ {'Removed reaction' if remove else 'Reacted'} {args.emoji} on {args.ts}")


def cmd_scopes(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Show available scopes for each token."""
    print("\n" + "=" * 70)
    print("🔑 SLACK TOKEN SCOPES")
    print("=" * 70)

    token_info = [
        ("Bot Token (xoxb)", tokens.bot_token),
    ]

    for name, token in token_info:
        print(f"\n📦 {name}:")

        if not token:
            print("   ❌ Not available")
            continue

        # Mask token for display
        masked = token[:15] + "..." + token[-8:]
        print(f"   Token: {masked}")

        # Test auth
        auth_result = client.test_auth(token)
        if auth_result.get("ok"):
            print(f"   ✅ Valid")
            print(f"   User: {auth_result.get('user', 'N/A')}")
            print(f"   Team: {auth_result.get('team', 'N/A')}")
            print(f"   URL: {auth_result.get('url', 'N/A')}")
        else:
            print(f"   ❌ Invalid: {auth_result.get('error', 'Unknown error')}")
            continue

        # Get scopes
        scopes = client.get_scopes(token)
        if scopes:
            print(f"\n   📋 Scopes ({len(scopes)}):")
            # Group scopes by category
            categories = {}
            for scope in sorted(scopes):
                category = scope.split(":")[0] if ":" in scope else scope.split(".")[0]
                if category not in categories:
                    categories[category] = []
                categories[category].append(scope)

            for category in sorted(categories.keys()):
                print(f"      [{category}]")
                for scope in categories[category]:
                    print(f"         • {scope}")
        else:
            print("   ⚠️  No scopes found (may be a legacy token)")

    # Show required scopes info
    print("\n" + "-" * 70)
    print("📋 REQUIRED SCOPES BY FEATURE:")
    print("-" * 70)
    print("   Basic Operations:")
    print("      • channels:read      - List channels")
    print("      • channels:history   - Read channel messages")
    print("      • chat:write         - Send messages")
    print("      • users:read         - List users")
    print("   File Uploads:")
    print("      • files:write        - Upload files")
    print("      • files:read         - Read file info (optional)")
    print("   Channel Management:")
    print("      • channels:join      - Join public channels")
    print("      • channels:manage    - Create/archive channels")
    print("   Private Channels:")
    print("      • groups:read        - List private channels")
    print("      • groups:history     - Read private channel messages")
    print("=" * 70 + "\n")


def cmd_channels(client: SlackClient, tokens: SlackTokens, args) -> None:
    """List all channels."""
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        return

    print("\n🔍 Fetching channels...")

    channel_types = (
        args.types
        if hasattr(args, "types") and args.types
        else "public_channel,private_channel"
    )
    channels = client.list_channels(token, types=channel_types)

    if not channels:
        print("❌ No channels found or error occurred")
        return

    # Sort by member count
    channels.sort(key=lambda x: x.get("num_members", 0), reverse=True)

    print(f"\n📢 Found {len(channels)} channels:\n")
    print(f"{'#':<4} {'Channel Name':<35} {'ID':<15} {'Members':<10} {'Private':<8}")
    print("-" * 75)

    for i, ch in enumerate(channels, 1):
        name = ch.get("name", "unknown")
        cid = ch.get("id", "N/A")
        members = ch.get("num_members", 0)
        is_private = "🔒" if ch.get("is_private") else ""
        print(f"{i:<4} #{name:<34} {cid:<15} {members:<10} {is_private}")

    print("-" * 75)

    # Save to file if requested
    if hasattr(args, "output") and args.output:
        with open(args.output, "w") as f:
            json.dump(channels, f, indent=2)
        print(f"\n💾 Saved to {args.output}")


def cmd_users(client: SlackClient, tokens: SlackTokens, args) -> None:
    """List all users."""
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        return

    print("\n🔍 Fetching users...")
    users = client.list_users(token)

    if not users:
        print("❌ No users found or error occurred")
        return

    # Filter out bots and deleted users unless requested
    if not (hasattr(args, "all") and args.all):
        users = [u for u in users if not u.get("is_bot") and not u.get("deleted")]

    print(f"\n👥 Found {len(users)} users:\n")
    print(f"{'#':<4} {'Username':<20} {'Real Name':<30} {'ID':<15}")
    print("-" * 70)

    for i, user in enumerate(users, 1):
        username = user.get("name", "unknown")
        real_name = user.get(
            "real_name", user.get("profile", {}).get("real_name", "N/A")
        )
        uid = user.get("id", "N/A")
        print(f"{i:<4} @{username:<19} {real_name:<30} {uid:<15}")

    print("-" * 70)

    if hasattr(args, "output") and args.output:
        with open(args.output, "w") as f:
            json.dump(users, f, indent=2)
        print(f"\n💾 Saved to {args.output}")


def cmd_history(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Get channel history."""
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        return

    workspace = args.workspace
    channel = args.channel
    limit = args.limit if hasattr(args, "limit") else 20

    print(f"\n🔍 Fetching history for {channel}...")
    messages = client.get_channel_history(token, workspace, channel, limit)

    if not messages:
        print("❌ No messages found or error occurred")
        return

    print(f"\n💬 Last {len(messages)} messages:\n")

    for msg in reversed(messages):
        user = msg.get("user", "unknown")
        text = msg.get("text", "")[:100]
        ts = msg.get("ts", "")

        # Check for bot messages
        if msg.get("bot_id") and msg.get("username"):
            user = msg.get("username")

        try:
            dt = datetime.fromtimestamp(float(ts))
            time_str = dt.strftime("%H:%M:%S")
        except:
            time_str = ts

        print(f"[{time_str}] {user}: {text}")


def cmd_replies(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Get thread replies."""
    # Use bot token (has channels:history scope)
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        return

    thread_ts = args.thread_ts
    limit = args.limit if hasattr(args, "limit") else 50

    config_path = (
        args.config_file
        if hasattr(args, "config_file") and args.config_file
        else AGENT_SETTINGS_PATH
    )
    config = SlackConfig.load(config_path)
    # Get workspace from args or config
    workspace = None
    if hasattr(args, "workspace") and args.workspace:
        workspace = args.workspace
    else:
        workspace = config.get_default_workspace()

    # Get channel from args or config
    channel = args.channel if hasattr(args, "channel") and args.channel else None
    if not channel:
        channel = config.default_channel_id or config.default_channel

    if not channel:
        print("❌ No channel specified and no default configured", file=sys.stderr)
        print(
            "💡 Set default: python slack_interface.py config --set-channel &quot;#channel&quot;",
            file=sys.stderr,
        )
        return

    print(f"\n🧵 Fetching replies for thread {thread_ts}...")
    messages = client.get_thread_replies(token, workspace, channel, thread_ts, limit)

    if not messages:
        print("❌ No replies found or error occurred")
        return

    print(f"\n💬 Thread with {len(messages)} messages:\n")
    print("=" * 80)

    for i, msg in enumerate(messages):
        user = msg.get("user", "unknown")
        text = msg.get("text", "")
        ts = msg.get("ts", "")

        # Check for bot messages
        if msg.get("bot_id") and msg.get("username"):
            user = msg.get("username")

        try:
            dt = datetime.fromtimestamp(float(ts))
            time_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        except:
            time_str = ts

        # Mark parent vs reply
        prefix = "📌 PARENT" if i == 0 else f"↳ Reply {i}"

        print(f"┌─ {user} [{time_str}] {prefix}")
        for line in text.split("\n"):
            print(f"│  {line}")
        print("└" + "─" * 79)

    print(f"\n📊 Total: {len(messages)} messages in thread")


def cmd_join(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Join a channel."""
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        return

    channel = args.channel
    print(f"\n🚪 Joining {channel}...")

    result = client.join_channel(token, channel)

    if result.get("ok"):
        ch = result.get("channel", {})
        print(f"✅ Joined #{ch.get('name', channel)}")
    else:
        print(f"❌ Failed: {result.get('error', 'Unknown error')}")


def cmd_create(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Create a new channel."""
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        return

    name = args.name
    is_private = args.private if hasattr(args, "private") else False

    print(f"\n🆕 Creating {'private ' if is_private else ''}channel #{name}...")

    result = client.create_channel(token, name, is_private)

    if result.get("ok"):
        ch = result.get("channel", {})
        print(f"✅ Created #{ch.get('name', name)}")
        print(f"   ID: {ch.get('id')}")
    else:
        print(f"❌ Failed: {result.get('error', 'Unknown error')}")


def cmd_info(client: SlackClient, tokens: SlackTokens, args) -> None:
    """Get channel info."""
    token = tokens.bot_token
    if not token:
        print("❌ No valid token available", file=sys.stderr)
        return

    channel = args.channel
    print(f"\n🔍 Getting info for {channel}...")

    result = client.get_channel_info(token, channel)

    if result.get("ok"):
        ch = result.get("channel", {})
        print(f"\n📢 Channel: #{ch.get('name', 'N/A')}")
        print(f"   ID: {ch.get('id', 'N/A')}")
        print(f"   Members: {ch.get('num_members', 0)}")
        print(f"   Private: {'Yes' if ch.get('is_private') else 'No'}")
        print(f"   Archived: {'Yes' if ch.get('is_archived') else 'No'}")
        print(f"   Topic: {ch.get('topic', {}).get('value', 'N/A')}")
        print(f"   Purpose: {ch.get('purpose', {}).get('value', 'N/A')}")
    else:
        print(f"❌ Failed: {result.get('error', 'Unknown error')}")


# ============================================================================
# Main Entry Point
# ============================================================================


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Slack Interface CLI - Interact with Slack from the command line",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
First-time setup:
  %(prog)s config --set-channel "#your-channel"
  %(prog)s config --set-agent nova

Examples:
  %(prog)s agents                          List available agents
  %(prog)s say "Hello team!"               Send message as configured agent
  %(prog)s read -l 20                      Read last 20 messages
  %(prog)s upload design.png -m "Review"   Upload file with comment
  %(prog)s react 1234567890.123456 eyes    Add a reaction to a message
  %(prog)s unreact 1234567890.123456 eyes  Remove the agent's reaction
  %(prog)s scopes                          Show token scopes

For more info: https://github.com/NinjaTech-AI/agent-team-logo-creator
        """,
    )
    parser.add_argument(
        "-C",
        "--config-file",
        default=AGENT_SETTINGS_PATH,
        help=f"Path to config file (default: {AGENT_SETTINGS_PATH})",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Agents command
    subparsers.add_parser("agents", help="List all available agents with avatars")

    # Config command
    config_parser = subparsers.add_parser("config", help="Show or set configuration")
    config_parser.add_argument(
        "--set-channel",
        metavar="CHANNEL",
        help='Set default channel (e.g., "#logo-creator" or "C0AAAAMBR1R")',
    )
    config_parser.add_argument(
        "--set-channel-id",
        metavar="CHANNEL_ID",
        help='Set default channel ID directly (skips API lookup, e.g., "C0AAAAMBR1R")',
    )
    config_parser.add_argument(
        "--set-workspace-id",
        metavar="WORKSPACE_ID",
        help='Set workspace/team ID directly (e.g., "T0A9Q27KD1T")',
    )
    config_parser.add_argument(
        "--set-agent",
        metavar="AGENT",
        help="Set default agent (nova, pixel, bolt, scout)",
    )

    # Say command (send to default channel as configured agent)
    say_parser = subparsers.add_parser("say", help="Send message as configured agent")
    say_parser.add_argument("message", help="Message text")
    say_parser.add_argument("-t", "--thread", help="Thread timestamp for reply")
    say_parser.add_argument(
        "-a", "--agent", help="Override default agent (e.g., ninja, nova, bolt)"
    )
    say_parser.add_argument(
        "--blocks",
        help="JSON-encoded Block Kit blocks array. Overrides auto-conversion.",
    )
    say_parser.add_argument(
        "--no-auto-blocks",
        action="store_true",
        help="Disable markdown table -> markdown block auto-conversion.",
    )

    # Read command (read messages from default channel)
    read_parser = subparsers.add_parser(
        "read", help="Read messages from default channel"
    )
    read_parser.add_argument("-c", "--channel", help="Override default channel")
    read_parser.add_argument(
        "-l",
        "--limit",
        type=int,
        default=50,
        help="Number of messages to fetch (default: 50)",
    )

    # Upload command (upload file to channel)
    upload_parser = subparsers.add_parser("upload", help="Upload a file to a channel")
    upload_parser.add_argument("file", help="Path to file to upload")
    upload_parser.add_argument("-c", "--channel", help="Override default channel")
    upload_parser.add_argument("-m", "--message", help="Comment to post with file")
    upload_parser.add_argument("--title", help="Title for the file")
    upload_parser.add_argument("-t", "--thread", help="Thread timestamp for reply")

    # React / unreact commands (add or remove an emoji reaction on a message)
    for name, help_text in (
        ("react", "Add an emoji reaction to a message"),
        ("unreact", "Remove the agent's emoji reaction from a message"),
    ):
        reaction_parser = subparsers.add_parser(name, help=help_text)
        reaction_parser.add_argument(
            "ts", help="Message timestamp (e.g., 1234567890.123456)"
        )
        reaction_parser.add_argument(
            "emoji",
            nargs="?",
            default="🥷",
            help="Emoji name or character (default: 🥷)",
        )
        reaction_parser.add_argument("-c", "--channel", help="Override default channel")

    # Scopes command
    subparsers.add_parser("scopes", help="Show available scopes for each token")

    # Channels command
    channels_parser = subparsers.add_parser("channels", help="List all channels")
    channels_parser.add_argument(
        "-t",
        "--types",
        default="public_channel,private_channel",
        help="Channel types (comma-separated)",
    )
    channels_parser.add_argument("-o", "--output", help="Save to JSON file")

    # Users command
    users_parser = subparsers.add_parser("users", help="List all users")
    users_parser.add_argument(
        "-a", "--all", action="store_true", help="Include bots and deleted users"
    )
    users_parser.add_argument("-o", "--output", help="Save to JSON file")

    # History command
    history_parser = subparsers.add_parser("history", help="Get channel history")
    history_parser.add_argument("channel", help="Channel ID or name")
    history_parser.add_argument(
        "-l", "--limit", type=int, default=20, help="Number of messages (default: 20)"
    )

    # Replies command
    replies_parser = subparsers.add_parser("replies", help="Get thread replies")
    replies_parser.add_argument(
        "thread_ts", help="Thread timestamp (e.g., 1234567890.123456)"
    )
    replies_parser.add_argument("-c", "--channel", help="Override default channel")
    replies_parser.add_argument(
        "-l", "--limit", type=int, default=50, help="Number of replies (default: 50)"
    )

    # Join command
    join_parser = subparsers.add_parser("join", help="Join a channel")
    join_parser.add_argument("channel", help="Channel ID or name")

    # Create command
    create_parser = subparsers.add_parser("create", help="Create a channel")
    create_parser.add_argument("name", help="Channel name")
    create_parser.add_argument(
        "-p", "--private", action="store_true", help="Create as private channel"
    )

    # Info command
    info_parser = subparsers.add_parser("info", help="Get channel info")
    info_parser.add_argument("channel", help="Channel ID or name")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    # Resolve workspace identity (no token needed).
    _setup_workspace()
    tokens = SlackTokens()

    # Create client
    client = SlackClient(tokens)

    # Execute command
    commands = {
        "agents": cmd_agents,
        "config": cmd_config,
        "say": cmd_say,
        "read": cmd_read,
        "upload": cmd_upload,
        "react": cmd_react,
        "unreact": cmd_unreact,
        "scopes": cmd_scopes,
        "channels": cmd_channels,
        "users": cmd_users,
        "history": cmd_history,
        "replies": cmd_replies,
        "join": cmd_join,
        "create": cmd_create,
        "info": cmd_info,
    }

    if args.command in commands:
        commands[args.command](client, tokens, args)
    else:
        parser.print_help()


# ============================================================================
# Python API for Programmatic Access
# ============================================================================

# Mapping from common Unicode emoji chars to Slack reaction name strings.
# monitor.py passes raw emoji chars; react()/unreact() use this to translate them.
_EMOJI_REACTION_MAP: Dict[str, str] = {
    "👻": "ghost",
    "🥷": "ninja",
    "🎶": "notes",
    "🎵": "musical_note",
    "💻": "computer",
    "🤖": "robot_face",
    "⚡": "zap",
    "🌟": "star",
    "🔥": "fire",
    "✅": "white_check_mark",
    "👀": "eyes",
}


class SlackInterface(MessagingInterface):
    """
    High-level Python API for Slack Interface.

    This class provides a convenient way to interact with Slack from Python code.
    It handles token loading, configuration, and provides simple methods for
    common operations.

    Attributes:
        tokens: SlackTokens instance with available tokens
        config: SlackConfig instance with user configuration
        client: SlackClient instance for API calls

    Example:
        from messaging.slack.interface import SlackInterface

        # Initialize (auto-loads tokens and config)
        slack = SlackInterface()

        # Check connection
        if not slack.is_connected:
            print("Please connect Slack first!")
            exit(1)

        # Send message to default channel
        slack.say("Hello from Python!")

        # Send to specific channel with custom identity
        slack.say("Hello!", channel="#general",
                  username="Nova", icon_url="https://...")

        # Upload a file
        slack.upload_file("design.png", comment="New design!")

        # Get channel history
        messages = slack.get_history(limit=10)
        for msg in messages:
            print(f"{msg.get('user')}: {msg.get('text')}")
    """

    supports_message_edit = False  # agent-event-cache has no edit/delete endpoint
    supports_activity_progress = True
    activity_provider = "slack"

    def __init__(
        self,
        config_file: str = AGENT_SETTINGS_PATH,
    ):
        """
        Initialize Slack Interface from config

        Args:
            config_file: Path to config file (default: ~/.agent_settings.json)
        """
        self.tokens = SlackTokens()
        self.config = SlackConfig.load(config_file)
        self.client = SlackClient(self.tokens)
        self._user_cache: Dict[str, str] = {}
        self._user_cache_expires_at: float = 0.0
        self._users_read_warning_logged_at: float = 0.0
        self._resolved_workspace_id: Optional[str] = None
        self._connected_cache: Optional[bool] = None
        self._connected_cache_at: float = 0.0

        # Resolve workspace identity at construction time (cache-only, no token).
        _resolve_workspace_identity(self.config, config_file)

    def _log_users_read_missing_once(self) -> None:
        now = time.time()
        if now - self._users_read_warning_logged_at < USER_CACHE_TTL_SECONDS:
            return
        self._users_read_warning_logged_at = now
        logger.warning(
            "Slack users.info failed (missing users:read or auth error); "
            "falling back to raw user IDs for unresolved senders"
        )

    def _prime_user_cache_if_stale(self) -> None:
        now = time.time()
        if self._user_cache and now < self._user_cache_expires_at:
            return
        try:
            for member in self.list_users():
                user_id = member.get("id")
                if not user_id:
                    continue
                name = display_name_from_slack_user(member)
                if name:
                    self._user_cache[user_id] = name
            self._user_cache_expires_at = now + USER_CACHE_TTL_SECONDS
        except Exception:
            logger.exception("Failed to prime Slack user cache from channel members")

    def _resolve_user(self, user_id: str) -> str:
        """Resolve a user ID to a display name using the local cache.

        The cache is primed from event-cache channel-members. No direct
        Slack API call is made; unresolved IDs are returned as-is.
        """
        if not user_id:
            return ""
        cached = self._user_cache.get(user_id)
        if cached:
            return cached
        return user_id

    @property
    def default_channel(self) -> Optional[str]:
        """Get the default channel (ID preferred, then name)."""
        return self.config.get_default_channel()

    @property
    def default_workspace(self) -> Optional[str]:
        return self.config.get_default_workspace()

    def reporting_ids(self) -> tuple[str | None, str | None]:
        """IDs only — get_default_* fall back to display names, which never match."""
        return self.config.default_team_id, self.config.default_channel_id

    def _resolve_workspace_id(self, channel_id: Optional[str]) -> Optional[str]:
        """Resolve the Slack team ID without provider credentials.

        Configured ``default_team_id`` wins. Otherwise looks it up once via
        agent-event-cache ``GET /db/workspace`` (never Slack ``auth.test``)
        and caches the result in memory for this process's lifetime.
        """
        if self.config.default_team_id:
            return self.config.default_team_id
        if self._resolved_workspace_id:
            return self._resolved_workspace_id
        if not channel_id:
            return None
        try:
            workspace = AgentEventCacheClient().get_workspace(channel_id)
            self._resolved_workspace_id = workspace.workspace_id
            return self._resolved_workspace_id
        except Exception as e:
            logger.warning(f"agent-event-cache get_workspace failed: {e}")
            return None

    @property
    def default_channel_name(self) -> Optional[str]:
        """Get the default channel name (e.g., "#logo-creator")."""
        return self.config.default_channel

    def get_unique_channel(self) -> str:
        """Return a stable workspace-scoped identifier for Pipedream Connect x-ninja-integration-channel-id.

        Format: ``slack-<team_id>.<channel_id>``
        Example: ``slack-T0A9Q27KD1T.C0B9KAF5F9P``

        The ``slack-`` prefix disambiguates the channel type when the gateway
        receives identifiers from multiple messaging adapters.

        Requires ``default_team_id`` and ``default_channel_id`` in
        ``~/.agent_settings.json`` (populated automatically on first
        Slack token load via auth.test).

        Raises:
            ValueError: If either field is missing from the config.
        """
        team_id = self.config.default_team_id
        channel_id = self.config.default_channel_id
        if not team_id or not channel_id:
            raise ValueError(
                "Cannot derive unique_channel: 'default_team_id' and/or "
                "'default_channel_id' missing from ~/.agent_settings.json."
            )
        return f"slack-{team_id}.{channel_id}"

    @property
    def is_connected(self) -> bool:
        """True if an authorized agent-event-cache read succeeds.

        No provider token is checked: the cache enforces authorization on
        every request, so this issues a one-message read and treats a 401/403
        as "not connected". The result is cached for one hour to avoid
        redundant network round-trips from callers other than the health check.
        """
        now = __import__("time").monotonic()
        if self._connected_cache is not None and now - self._connected_cache_at < 3600:
            return self._connected_cache

        result = self._check_connected()
        self._connected_cache = result
        self._connected_cache_at = now
        return result

    def _check_connected(self) -> bool:
        """Live (uncached) connectivity check against the event-cache."""
        channel_id = self.config.default_channel_id
        if not channel_id:
            return False
        workspace_id = self._resolve_workspace_id(channel_id)
        if not workspace_id:
            return False
        return AgentEventCacheClient().can_get_messages(workspace_id, channel_id)

    # ------------------------------------------------------------------
    # Outbound via agent-event-cache
    #
    # The service holds the bot token and speaks Slack on our behalf, so the
    # sandbox does not need chat:write / files:write of its own. Every path
    # below falls back to the direct Slack API on failure: a write cannot be
    # safely retried, but it can be re-attempted against the provider, which
    # fails loudly instead of silently dropping the agent's reply.
    # ------------------------------------------------------------------

    def _outbound_client(self) -> AgentEventCacheClient:
        """Return the agent-event-cache client for outbound writes."""
        return AgentEventCacheClient()

    def _render_for_service(self, message: str) -> tuple[str, Optional[List[Dict]]]:
        """Split a Markdown message into the text and blocks the service takes.

        Two conversions cannot move server-side:

          * ``0.0.0.0:<port>`` rewriting needs the sandbox's own hostname.
          * Markdown tables only render as Block Kit, which the service passes
            through untouched; its Markdown renderer leaves them literal.

        Inline formatting deliberately is *not* converted here — the service
        renders mrkdwn itself, and pre-rendered mrkdwn would be converted a
        second time (``*bold*`` re-reads as italic).
        """
        text = convert_sandbox_urls(message)
        blocks, fallback = md_to_slack_blocks(text)
        # fallback is a plain-text preview, safe to hand to the renderer.
        return (fallback, blocks) if blocks else (text, None)

    def _say_via_event_cache(
        self,
        client: AgentEventCacheClient,
        message: str,
        channel_id: str,
        thread_ts: Optional[str],
        username: Optional[str],
        icon_url: Optional[str],
        icon_emoji: Optional[str],
        agent_name: Optional[str],
    ) -> Dict:
        """POST /messages/send, shaped like a chat.postMessage response.

        Callers (progress_service, cmd_say) read ``ok`` / ``ts`` / ``channel``,
        so the return keeps those keys rather than the service's own names.

        Both avatar overrides go over: the service applies Slack's own
        precedence, ignoring ``icon_emoji`` when ``icon_url`` is set.
        """
        text, blocks = self._render_for_service(message)
        # Same MSG SENDING / MSG SENT shape the direct path emits, so the
        # monitor log reads the same whichever route was taken. Without this,
        # enabling the service silently removed those lines and the log looked
        # like the agent had stopped replying. ``via`` is how you tell them
        # apart.
        sender = username or "bot"
        preview = text[:200] + ("..." if len(text) > 200 else "")
        logger.info(f"MSG SENDING [{sender} → {channel_id}] via=event-cache: {preview}")
        workspace_id = self._resolve_workspace_id(channel_id)
        if not workspace_id:
            raise ValueError("Slack workspace_id could not be resolved")
        response = client.send_message(
            SendMessageRequest(
                provider=MessageProvider.SLACK,
                workspace_id=workspace_id,
                channel_id=channel_id,
                text=text,
                thread_id=thread_ts,
                agent=agent_name,
                username=username,
                icon_url=icon_url,
                icon_emoji=icon_emoji,
                blocks=blocks,
            )
        )
        logger.info(
            f"MSG SENT [{sender} → {response.channel_id}] via=event-cache "
            f"ts={response.message_id}"
        )
        return {
            "ok": True,
            "ts": response.message_id,
            "channel": response.channel_id,
        }

    def say(
        self,
        message: str,
        channel: Optional[str] = None,
        thread_ts: Optional[str] = None,
        username: Optional[str] = None,
        icon_emoji: Optional[str] = None,
        icon_url: Optional[str] = None,
        agent: Optional[str] = None,
    ) -> Dict:
        """
        Send a message to the default channel or specified channel.

        Posts under the configured agent (``default_agent`` in
        ``~/.agent_settings.json``) by default. Pass ``username`` /
        ``icon_url`` / ``icon_emoji`` to override, or ``agent`` to post as
        a different known agent.
        """
        target_channel = channel or self.default_channel
        if not target_channel:
            raise ValueError(
                "No channel specified and no default channel configured. "
                "Set default with: slack.set_default_channel('#channel-name')"
            )

        # Auto-resolve agent identity from default_agent (matches upload_file).
        agent_name = agent or self.config.default_agent
        agent_config = get_agent_avatar(agent_name) if agent_name else None
        if agent_config:
            if username is None:
                username = agent_config.get("name")
            if icon_url is None and icon_emoji is None:
                icon_url = agent_config.get("icon_url")
                if not icon_url:
                    icon_emoji = agent_config.get("icon_emoji")

        try:
            return self._say_via_event_cache(
                self._outbound_client(),
                message,
                self._resolve_channel_id(target_channel),
                thread_ts,
                username,
                icon_url,
                icon_emoji,
                agent_name,
            )
        except Exception as e:
            logger.error(
                f"MSG FAILED [{username or 'bot'} → {target_channel}]: {e}",
                exc_info=True,
            )
            raise

    def upload_file(
        self,
        file_path: str,
        channel: Optional[str] = None,
        title: Optional[str] = None,
        comment: Optional[str] = None,
        thread_ts: Optional[str] = None,
        agent: Optional[str] = None,
    ) -> Dict:
        """
        Upload a file to the default channel (or specified channel) and post
        it under the configured agent's identity, via agent-event-cache
        (POST /messages/upload) — the sandbox has no Slack file/chat scopes
        of its own.

        Args:
            file_path: Path to the file on disk.
            channel:   Optional channel override. Defaults to the configured
                       default channel.
            title:     Optional file title (defaults to the filename).
            comment:   Optional narrative text to include above the permalink
                       in the agent's message.
            thread_ts: Optional thread timestamp to post into.
            agent:     Optional agent identifier. Defaults to the configured
                       default_agent.

        Returns:
            Dict with:
              - ok:          bool
              - file:        {"id": ..., "title": ...}
              - permalink:   Slack permalink to the uploaded file
              - message_ts:  timestamp of the agent's post
              - channel_id:  the resolved channel ID the file was shared to
              - agent:       {"id": ..., "name": ...} when resolved
        """
        target_channel = channel or self.default_channel
        if not target_channel:
            raise ValueError("No channel specified and no default configured")

        # Resolve channel name to ID if needed
        channel_id = target_channel
        if target_channel.startswith("#"):
            channel_id = self._resolve_channel_id(target_channel)
        if channel_id.startswith("#"):
            raise ValueError(
                f"Could not resolve channel {target_channel!r} to a channel ID"
            )

        # Resolve the agent identity (used for the message's author override).
        agent_name = agent or self.config.default_agent
        agent_config = get_agent_avatar(agent_name) if agent_name else None

        file_title = title or Path(file_path).name

        return self._upload_via_event_cache(
            self._outbound_client(),
            file_path,
            channel_id,
            file_title,
            comment,
            thread_ts,
            agent_name,
            agent_config,
        )

    def _upload_via_event_cache(
        self,
        client: AgentEventCacheClient,
        file_path: str,
        channel_id: str,
        file_title: str,
        comment: Optional[str],
        thread_ts: Optional[str],
        agent_name: Optional[str],
        agent_config: Optional[Dict[str, str]],
    ) -> Dict:
        """POST /messages/upload, shaped like upload_file()'s own return.

        The service reports only the ids it has (``file_id``, ``permalink``,
        ``message_id``), so ``file`` is reconstructed with what we know rather
        than echoing a full Slack file object we never saw.
        """
        path = Path(file_path).expanduser()
        workspace_id = self._resolve_workspace_id(channel_id)
        if not workspace_id:
            raise ValueError("Slack workspace_id could not be resolved")
        response = client.upload_file(
            provider=MessageProvider.SLACK,
            workspace_id=workspace_id,
            channel_id=channel_id,
            content=path.read_bytes(),
            filename=path.name,
            title=file_title,
            comment=comment,
            thread_id=thread_ts,
            username=agent_config.get("name") if agent_config else None,
            icon_url=agent_config.get("icon_url") if agent_config else None,
            icon_emoji=agent_config.get("icon_emoji") if agent_config else None,
        )
        logger.info(
            f"UPLOAD OK [{path.name} → {response.channel_id}] via=event-cache "
            f"file={response.file_id} ts={response.message_id}"
        )
        result: Dict = {
            "ok": True,
            "file": {"id": response.file_id, "title": file_title},
            "permalink": response.permalink,
            "message_ts": response.message_id,
            "channel_id": response.channel_id,
        }
        if agent_config:
            result["agent"] = {"id": agent_name, "name": agent_config.get("name")}
        return result

    def _resolve_channel_id(self, channel_name: str) -> str:
        """
        Resolve a channel name (e.g., '#general') to its ID.

        Args:
            channel_name: Channel name with # prefix

        Returns:
            Channel ID string, or original name if not found
        """
        if not channel_name.startswith("#"):
            return channel_name

        name = channel_name[1:]
        try:
            channels = self.list_channels()
            for ch in channels:
                if ch.get("name") == name:
                    return ch.get("id", channel_name)
        except Exception:
            pass

        return channel_name

    def set_default_channel(
        self, channel: str, config_file: str = AGENT_SETTINGS_PATH
    ) -> None:
        """
        Set the default channel for future messages.

        Args:
            channel: Channel name (e.g., "#logo-creator") or ID (e.g., "C0AAAAMBR1R")
            config_file: Path to save config (default: ~/.agent_settings.json)
        """
        if channel.startswith("#"):
            # Try to resolve channel ID
            channels = self.list_channels()
            channel_name = channel[1:]
            for ch in channels:
                if ch.get("name") == channel_name:
                    self.config.default_channel = channel
                    self.config.default_channel_id = ch.get("id")
                    break
            else:
                self.config.default_channel = channel
                self.config.default_channel_id = None
        else:
            self.config.default_channel_id = channel

        self.config.save(config_file)

    def list_channels(
        self, types: str = "public_channel,private_channel"
    ) -> List[Dict]:
        """
        List all channels in the workspace.

        Args:
            types: Comma-separated channel types to include

        Returns:
            List of channel dicts with 'id', 'name', 'num_members', etc.
        """
        if not self.is_connected:
            raise RuntimeError("Slack not connected")
        return self.client.list_channels("", types)

    def list_users(self) -> List[Dict]:
        """
        List all users in the workspace.

        Uses the agent-event-cache channel-members endpoint when a default
        channel is configured, falling back to Slack API otherwise.

        Returns:
            List of user dicts with 'id', 'name', 'real_name', etc.
        """
        if not self.is_connected:
            raise RuntimeError("Slack not connected")
        channel_id = self.config.default_channel_id
        return self.client.list_users("", channel_id=channel_id)

    def get_history(self, channel: Optional[str] = None, limit: int = 50) -> List[Dict]:
        """
        Get channel message history via the agent-event-cache service.

        Args:
            channel: Optional channel override (uses default if not specified)
            limit: Number of messages to retrieve (default: 50)

        Returns:
            List of message dicts (newest first). An empty successful
            response is a real empty channel, not a failure.

        Raises:
            requests.HTTPError: On 4xx/5xx (403 = unauthorized channel).
            ValueError: Configuration missing, or a returned message lacks
                valid ``sender``/``mentions`` identity.
        """
        target_channel = channel or self.default_channel
        if not target_channel:
            raise ValueError("No channel specified and no default configured")
        channel_id = self._resolve_channel_id(target_channel)
        workspace_id = self._resolve_workspace_id(channel_id)
        if not workspace_id:
            raise ValueError("Slack workspace_id could not be resolved")

        response = AgentEventCacheClient().get_messages(
            GetMessagesRequest(
                workspace_id=workspace_id, channel_id=channel_id, limit=limit
            )
        )
        return [CacheMessage.model_validate(m).model_dump() for m in response.messages]

    def get_replies(
        self, thread_ts: str, channel: Optional[str] = None, limit: int = 50
    ) -> List[Dict]:
        """
        Get replies to a thread via the agent-event-cache service.

        Args:
            thread_ts: Timestamp of the parent message
            channel: Optional channel override (uses default if not specified)
            limit: Number of replies to retrieve (default: 50)

        Returns:
            List of message dicts (parent first, then replies in chronological order)

        Raises:
            requests.HTTPError: On 4xx/5xx (403 = unauthorized channel).
            ValueError: Configuration missing, or a returned message lacks
                valid ``sender``/``mentions`` identity.
        """
        target_channel = channel or self.default_channel
        if not target_channel:
            raise ValueError("No channel specified and no default configured")
        channel_id = self._resolve_channel_id(target_channel)
        workspace_id = self._resolve_workspace_id(channel_id)
        if not workspace_id:
            raise ValueError("Slack workspace_id could not be resolved")
        replies = self.client.get_thread_replies(
            None, workspace_id, channel_id, thread_ts, limit
        )
        return [CacheMessage.model_validate(m).model_dump() for m in replies]

    def react(self, ts: str, emoji: str = "🥷", channel: Optional[str] = None) -> bool:
        """
        Add an emoji reaction to a message via agent-event-cache.

        Accepts a raw Unicode emoji character (e.g. ``"🥷"``) or a Slack
        reaction name string (e.g. ``"ninja"``). Unicode chars are translated
        via ``_EMOJI_REACTION_MAP``; unrecognised chars fall back to ``"ghost"``.

        Args:
            ts:      Message timestamp (ts field from the Slack message)
            emoji:   Unicode emoji char or Slack reaction name (default: "🥷")
            channel: Optional channel override (uses default if not specified)

        Returns:
            True on success. Raises on failure — callers already treat
            react() as best-effort and catch broadly.
        """
        request = self._reaction_request(ts, emoji, channel)
        if request is None:
            return False
        self._outbound_client().react(request)
        logger.info(
            f"REACT OK [:{request.emoji}: → {request.channel_id}] via=event-cache ts={ts}"
        )
        return True

    def unreact(
        self, ts: str, emoji: str = "🥷", channel: Optional[str] = None
    ) -> bool:
        """
        Remove the agent's emoji reaction from a message via agent-event-cache.

        Mirror of react(): same arguments and emoji translation. Removing a
        reaction that isn't there is a success, so swapping an ack (👀 → ✅)
        is safe to retry.

        Returns:
            True on success. Raises on failure.
        """
        request = self._reaction_request(ts, emoji, channel)
        if request is None:
            return False
        self._outbound_client().unreact(request)
        logger.info(
            f"UNREACT OK [:{request.emoji}: → {request.channel_id}] via=event-cache ts={ts}"
        )
        return True

    def _reaction_request(
        self, ts: str, emoji: str, channel: Optional[str]
    ) -> Optional[ReactRequest]:
        """Build the react/unreact body, or None when the target can't be resolved."""
        target_channel = channel or self.default_channel
        if not target_channel:
            return None
        channel_id = self._resolve_channel_id(target_channel)
        workspace_id = self._resolve_workspace_id(channel_id)
        if not workspace_id:
            return None
        # Translate Unicode emoji to Slack reaction name if needed. This stays
        # client-side: the service passes the emoji straight to reactions.add
        # and reactions.remove, which only accept names.
        reaction_name = (
            _EMOJI_REACTION_MAP.get(emoji, emoji) if len(emoji) <= 2 else emoji
        )
        return ReactRequest(
            provider=MessageProvider.SLACK,
            workspace_id=workspace_id,
            channel_id=channel_id,
            message_id=ts,
            emoji=reaction_name,
        )

    def update_message(
        self,
        ts: str,
        text: str,
        blocks: Optional[list] = None,
        channel: Optional[str] = None,
    ) -> bool:
        """Unsupported in the cache-only runtime — agent-event-cache has no
        edit endpoint, and there is no Slack token to call chat.update
        directly. Always returns False; see ``supports_message_edit``.
        """
        return False

    def delete_message(self, ts: str, channel: Optional[str] = None) -> bool:
        """Unsupported in the cache-only runtime — agent-event-cache has no
        delete endpoint, and there is no Slack token to call chat.delete
        directly. Always returns False; see ``supports_message_edit``.
        """
        return False

    def activity_workspace_id(self):
        return self._resolve_workspace_id(self.config.default_channel_id)

    def start_activity(self, thread_id, username=None, icon_url=None):
        """Start a server-side progress bar in the thread."""
        workspace_id = self._resolve_workspace_id(self.config.default_channel_id)
        if not workspace_id:
            return None
        agent = get_agent_avatar(self.config.default_agent or "") or {}
        try:
            result = AgentEventCacheClient().start_activity(
                StartActivityRequest(
                    provider=MessageProvider.SLACK,
                    workspace_id=workspace_id,
                    channel_id=self.config.default_channel_id,
                    thread_id=thread_id,
                    username=username or agent.get("name"),
                    icon_url=icon_url or agent.get("icon_url"),
                )
            )
            return {"id": result.id, "message_id": result.message_id}
        except Exception as e:
            logger.warning(f"start_activity failed: {e}")
            return None

    def add_completed_action(self, thread_id, label):
        """Report a completed step to the server-side progress bar."""
        workspace_id = self._resolve_workspace_id(self.config.default_channel_id)
        if not workspace_id:
            return False
        try:
            AgentEventCacheClient().add_completed_action(
                AddCompletedActionRequest(
                    provider=MessageProvider.SLACK,
                    workspace_id=workspace_id,
                    channel_id=self.config.default_channel_id,
                    thread_id=thread_id,
                    label=label,
                )
            )
            return True
        except Exception as e:
            logger.warning(f"add_completed_action failed: {e}")
            return False

    def tick_activity(self, thread_id):
        """Heartbeat to advance the server-side progress bar."""
        workspace_id = self._resolve_workspace_id(self.config.default_channel_id)
        if not workspace_id:
            return False
        try:
            AgentEventCacheClient().tick_activity(
                TickActivityRequest(
                    provider=MessageProvider.SLACK,
                    workspace_id=workspace_id,
                    channel_id=self.config.default_channel_id,
                    thread_id=thread_id,
                )
            )
            return True
        except Exception as e:
            logger.warning(f"tick_activity failed: {e}")
            return False

    def complete_activity(self, thread_id):
        """Remove the server-side progress bar from the thread."""
        workspace_id = self._resolve_workspace_id(self.config.default_channel_id)
        if not workspace_id:
            return False
        try:
            AgentEventCacheClient().complete_activity(
                CompleteActivityRequest(
                    provider=MessageProvider.SLACK,
                    workspace_id=workspace_id,
                    channel_id=self.config.default_channel_id,
                    thread_id=thread_id,
                )
            )
            return True
        except Exception as e:
            logger.warning(f"complete_activity failed: {e}")
            return False

    def is_own_message(self, message: Dict) -> bool:
        """Return True if ``message`` was sent by this Ninja bot family."""
        return CacheMessage.model_validate(message).sender.is_ninja

    def is_bot_message(self, message: Dict) -> bool:
        """Return True if ``message`` was posted by any bot or app."""
        return CacheMessage.model_validate(message).sender.is_bot

    def is_human_message(self, message: Dict) -> bool:
        """Return True if ``message`` was sent by a real human Slack user.

        Excludes bots, app messages, and channel system events (join, topic
        change, etc. — identified by a non-empty ``subtype``).
        """
        if self.is_bot_message(message):
            return False
        subtype = message.get("subtype")
        if subtype and subtype != "file_share":
            return False
        return bool(message.get("user"))

    def has_audio_attachment(self, message: Dict) -> bool:
        """Return True if ``message`` contains an audio or voice attachment.

        Checks each entry in ``message["files"]`` for a mimetype starting with
        ``audio/`` or a ``subtype`` of ``voice_message`` (Slack's native voice
        clip format).
        """
        for f in message.get("files", []):
            if (
                f.get("mimetype", "").startswith("audio/")
                or f.get("subtype") == "voice_message"
            ):
                return True
        return False

    # ------------------------------------------------------------------
    # Monitor integration — ABC implementation
    # ------------------------------------------------------------------
    # Attachment classification + message typing use the shared
    # message_utils.extract_file_attachments / classify_message_type (field-
    # tolerant across adapters) — no Slack-specific copy.

    def collect_pending(
        self,
        msg: Dict,
        agent_mentions: list,
        seen_messages: set,
        agent_data: dict,
        message_states: MessageStateBatch | None = None,
    ) -> List[PendingMessage]:
        """Process a single Slack message from get_history().

        For the message itself and any unseen thread replies:
          1. Skips already-seen messages and own posts.
          2. Reacts with the configured agent emoji when warranted.
          3. Classifies and returns actionable messages.
          4. Reports each triage decision (seen + will-reply) to ``message_states``
             when tracking is enabled (SN-3996).

        A single unified loop handles both main-channel messages and thread
        replies with identical filter / react / classify logic.
        """
        # `is None`, not `or`: an empty batch is falsy, so `or` would throw
        # away the caller's batch on every poll and report nothing.
        if message_states is None:
            message_states = NO_MESSAGE_STATES
        emoji = os.environ.get("NINJA_AGENT_EMOJI", "🥷").strip()
        pending_messages: List[PendingMessage] = []

        msg_id = msg.get("ts", "") or msg.get("timestamp", "")
        if not msg_id:
            return pending_messages

        msg_thread_ts = msg.get("thread_ts")
        is_top_level = not msg_thread_ts or msg_thread_ts == msg_id

        if is_top_level:
            if msg_id in seen_messages:
                return pending_messages
            seen_messages.add(msg_id)

        # Build candidate list: the message itself, plus thread replies if any.
        # Tag each candidate with from_replies so the parent-skip guard only
        # fires for messages returned by get_replies(), not the original msg.
        # Only call get_replies() when there is evidence of thread activity —
        # the agent-event-cache strips reply_count but preserves latest_reply.
        candidates = [(msg, False)]  # (message, from_replies)
        has_thread_activity = msg.get("reply_count", 0) > 0 or bool(
            msg.get("latest_reply")
        )
        if has_thread_activity:
            try:
                replies = self.get_replies(msg_id)
                candidates += [(r, True) for r in replies]
            except Exception as e:
                # Logged, not silently absorbed: a 401/403 or contract
                # failure here must be visible, even though — pre-existing
                # limitation — msg_id is already in seen_messages by this
                # point, so a failed thread fetch is not retried next poll.
                logger.warning(f"get_replies failed for {msg_id}: {e}")

        unresolved = collect_unresolved_user_ids(candidates)
        if unresolved:
            self._prime_user_cache_if_stale()

        # Unified loop — identical logic for main-channel messages and replies.
        for candidate, from_replies in candidates:
            cand_ts = candidate.get("ts", "") or candidate.get("timestamp", "")
            if not cand_ts:
                continue
            cand_thread_ts = candidate.get("thread_ts")
            is_reply = bool(cand_thread_ts and cand_thread_ts != cand_ts)
            reply_id = f"{cand_thread_ts}:{cand_ts}" if is_reply else None
            # Top-level posts report no thread; replies report their root.
            report_thread_id = cand_thread_ts if is_reply else None

            # get_replies() always includes the parent as the first item — skip
            # it, but only when processing get_replies() results (from_replies).
            if from_replies and cand_ts == msg_id:
                continue

            # Skip replies already processed in a previous cycle.
            if reply_id and reply_id in seen_messages:
                continue

            # Step 1: Decide whether this candidate earns a reply, and whether
            # to ack it. Own posts earn neither; humans always earn both; other
            # bots only when they explicitly mention Ninja (typed mention, not
            # a text-substring match).
            cand_msg = CacheMessage.model_validate(candidate)
            is_mentioned = cand_msg.mentions_ninja
            is_own = self.is_own_message(candidate)
            is_bot = cand_msg.sender.is_bot
            should_respond = not is_own and (not is_bot or is_mentioned)
            should_react = not is_own and (
                self.is_human_message(candidate) or (is_bot and is_mentioned)
            )

            # Step 2: Retire the ones we decline, and say so upstream. The
            # seen-bookkeeping and the report travel together — doing one
            # without the other is what leaves a message pending forever.
            if not should_respond:
                logger.info(
                    f"Declinig to respond {cand_ts} (own={is_own}, bot={is_bot}, mention={is_mentioned})"
                )
                if reply_id:
                    seen_messages.add(reply_id)
                message_states.seen(cand_ts, report_thread_id, will_reply=False)
                continue

            # Step 3: React (best-effort).
            if should_react:
                try:
                    self.react(cand_ts, emoji)
                except Exception:
                    pass
            # Step 4: Classify and queue.
            attachments = extract_file_attachments(
                candidate,
                event_id=cand_msg.event_id or "",
            )
            msg_type = classify_message_type(attachments, is_reply)
            user_id = candidate.get("user") or ""
            display_name = resolve_slack_sender_name(candidate, self._resolve_user)
            message_text = resolve_slack_mentions(
                candidate.get("text", ""),
                self._resolve_user,
                self._user_cache,
            )
            # Overlay the more thoroughly resolved display name / user id on top
            sender = cand_msg.sender.model_copy(
                update={
                    "display_name": display_name,
                    "user_id": user_id or cand_msg.sender.user_id,
                }
            )
            pending_messages.append(
                PendingMessage(
                    id=cand_ts,
                    thread_id=cand_thread_ts if is_reply else cand_ts,
                    text=message_text,
                    sender=sender,
                    mentions=cand_msg.mentions,
                    raw=candidate,
                    type=msg_type,
                    audio_files=[
                        FileAttachment(**f) for f in attachments["audio_files"]
                    ],
                    image_files=[
                        FileAttachment(**f) for f in attachments["image_files"]
                    ],
                    pdf_files=[FileAttachment(**f) for f in attachments["pdf_files"]],
                    other_files=[
                        FileAttachment(**f) for f in attachments["other_files"]
                    ],
                )
            )
            message_states.seen(cand_ts, report_thread_id, will_reply=True)

            # Step 5: Bookkeeping for replies.
            if reply_id:
                seen_messages.add(reply_id)

        return pending_messages

    def _welcome_via_event_cache(
        self,
        client: AgentEventCacheClient,
        agent: dict,
        welcome_text: str,
        welcome_signature: str,
    ) -> bool:
        """POST /messages/welcome and record the outcome locally.

        ``posted=False`` means the channel was already greeted or a human got
        there first — both are terminal, so the local flag is set either way
        and the monitor stops asking on every restart.
        """
        channel = self.default_channel
        if not channel:
            raise ValueError("No channel configured for the welcome message")
        channel_id = self._resolve_channel_id(channel)
        workspace_id = self._resolve_workspace_id(channel_id)
        if not workspace_id:
            raise ValueError("Slack workspace_id could not be resolved")
        agent_name = self.config.default_agent
        agent_config = get_agent_avatar(agent_name) if agent_name else None
        response = client.send_welcome(
            WelcomeRequest(
                provider=MessageProvider.SLACK,
                workspace_id=workspace_id,
                channel_id=channel_id,
                text=convert_sandbox_urls(welcome_text),
                signature=welcome_signature,
                agent=agent_name,
                username=agent_config.get("name") if agent_config else None,
                icon_url=agent_config.get("icon_url") if agent_config else None,
                icon_emoji=agent_config.get("icon_emoji") if agent_config else None,
            )
        )
        agent["welcomed"] = True
        try:
            save_agent_messages(agent)
        except Exception:
            pass
        if response.posted:
            logger.info(
                f"WELCOME POSTED [{response.channel_id}] via=event-cache "
                f"ts={response.message_id}"
            )
            self.capture_welcome_message("slack")
        else:
            logger.info(
                f"Welcome skipped by agent-event-cache (reason={response.reason})"
            )
        return response.posted

    def post_welcome_if_needed(
        self, agent: dict, welcome_text: str, welcome_signature: str
    ) -> bool:
        """Post ``welcome_text`` if the channel has no prior human messages.

        Idempotency layers:
          1. Persisted ``welcomed`` flag in ``.agent_messages.json``
             (loaded and saved by the caller via agent_data).
          2. The service's own check against cached history, which unlike the
             local flag survives a sandbox reclone.
        """
        logger.info(f"Agent messages state: {agent}")
        if agent.get("welcomed"):
            logger.info(
                f"Agent already welcomed in this channel; skipping welcome announcement."
            )
            return False

        return self._welcome_via_event_cache(
            self._outbound_client(), agent, welcome_text, welcome_signature
        )

    def check_messaging_health(self) -> Dict:
        """Validate Slack connectivity via a live event-cache message read.

        Always hits the network (no cache) so the health service sees
        real-time status.  The result is propagated to the ``is_connected``
        cache so other callers benefit without an extra round-trip.

        Returns:
            {"service": "slack", "status": "ok"}           on success
            {"service": "slack", "status": "disconnected", "message": "..."}  on auth failure
            {"service": "slack", "status": "error",        "message": "..."}  on exception
        """
        try:
            result = self._check_connected()
            # Refresh the is_connected cache with the live result.
            self._connected_cache = result
            self._connected_cache_at = __import__("time").monotonic()
            if result:
                return {"service": "slack", "status": "ok"}
            return {
                "service": "slack",
                "status": "disconnected",
                "message": "Cannot read channel via event-cache (unauthorized or misconfigured)",
            }
        except Exception as e:
            return {"service": "slack", "status": "error", "message": str(e)}

    def join_channel(self, channel: str) -> Dict:
        """Not supported — channel management is handled outside the sandbox."""
        raise RuntimeError(
            "join_channel is not available; channels are managed externally"
        )

    def create_channel(self, name: str, is_private: bool = False) -> Dict:
        """Not supported — channel management is handled outside the sandbox."""
        raise RuntimeError(
            "create_channel is not available; channels are managed externally"
        )

    def get_scopes(self) -> List[str]:
        """Not available — no provider token in the sandbox."""
        return []


# Convenience function for quick messaging
def say(
    message: str,
    channel: Optional[str] = None,
    username: Optional[str] = None,
    icon_emoji: Optional[str] = None,
) -> Dict:
    """
    Quick function to send a message to the default channel.

    This is a convenience wrapper around SlackInterface for simple use cases.

    Args:
        message: Message text to send
        channel: Optional channel override
        username: Optional custom username
        icon_emoji: Optional emoji icon

    Returns:
        Slack API response dict

    Example:
        from messaging.slack.interface import say
        say("Hello from Python!")
        say("Hello!", channel="#general")
        say("Hello!", username="Nova", icon_emoji=":star:")
    """
    slack = SlackInterface()
    return slack.say(message, channel, username=username, icon_emoji=icon_emoji)


if __name__ == "__main__":
    main()
