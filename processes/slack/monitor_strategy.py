"""Slack monitor strategy — polling loop for Slack channels.

Inherits the shared polling loop from ``processes.common.PollingMonitorStrategy``.
"""

from __future__ import annotations

from processes.common import PollingMonitorStrategy


class SlackMonitorStrategy(PollingMonitorStrategy):
    """Slack channel monitor — poll-based loop."""

    pass
