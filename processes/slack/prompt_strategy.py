"""Slack prompt strategy — provides Slack-specific prompt variables."""

from __future__ import annotations

from processes.base import PromptStrategy, PromptVars


class SlackPromptStrategy(PromptStrategy):
    """Slack channel prompt variable provider."""

    def get_prompt_vars(self, config: dict) -> PromptVars:
        channel = config.get(
            "default_channel_name", config.get("default_channel", "#your-channel")
        )
        return PromptVars(
            channel=channel,
            default_task=(
                f"Check Slack {channel} for new requests, do your work, "
                "and reflect and improve your toolkit "
                "as per agent-docs/ORCHESTRATOR.md."
            ),
            interface_doc=(
                "3. **Slack Interface Docs:** `cat agent-docs/SLACK_INTERFACE.md`"
            ),
        )
