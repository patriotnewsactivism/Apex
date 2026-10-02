#!/usr/bin/env bash
# install/slack.sh — Slack-specific installation steps.
#
# Called by install.sh after the common steps complete.
# Handles: timezone alignment (via workspace timezone) + Slack channel config.
#
# Usage:
#   bash install/slack.sh --channel "#my-channel" --channel-id "C0AAAAMBR1R" [--workspace-id "T0A9Q27KD1T"]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NINJA_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

SLACK_CHANNEL=""
SLACK_CHANNEL_ID=""
SLACK_WORKSPACE_ID=""
SLACK_AGENT="ninja"  # always ninja — only one agent in this repo

usage() {
    echo "Usage: $0 --channel CHANNEL --channel-id CHANNEL_ID [--workspace-id WORKSPACE_ID]"
    echo ""
    echo "Options:"
    echo "  --channel CHANNEL            Slack channel name (required, e.g. '#my-channel')"
    echo "  --channel-id CHANNEL_ID      Slack channel ID (required, e.g. 'C0AAAAMBR1R')"
    echo "  --workspace-id WORKSPACE_ID  Slack workspace/team ID (optional, e.g. 'T0A9Q27KD1T')"
    echo "  --help                       Show this help message"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --channel)      SLACK_CHANNEL="$2"; shift 2 ;;
        --channel-id)   SLACK_CHANNEL_ID="$2"; shift 2 ;;
        --workspace-id) SLACK_WORKSPACE_ID="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
done

if [[ -z "$SLACK_CHANNEL" || -z "$SLACK_CHANNEL_ID" ]]; then
    echo "ERROR: --channel and --channel-id are required for Slack"
    usage
    exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Align system timezone with Slack workspace timezone
# ---------------------------------------------------------------------------
echo ""
echo "▶ Aligning system timezone with workspace timezone..."
TZ_SCRIPT="$NINJA_DIR/infra/initial_setup_scripts/set_timezone.py"
if [[ -f "$TZ_SCRIPT" ]]; then
    if python "$TZ_SCRIPT" --quiet >/dev/null; then
        CURRENT_TZ="$(cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')"
        echo "  ✓ Timezone: ${CURRENT_TZ:-unknown}"
    else
        echo "  ⚠ set_timezone.py exited non-zero — continuing with current system timezone."
    fi
else
    echo "  ⚠ ${TZ_SCRIPT} not found — skipping timezone sync."
fi

# ---------------------------------------------------------------------------
# Step 2: Configure Slack channel
# ---------------------------------------------------------------------------
echo ""
echo "▶ Configuring Slack channel..."

python "$NINJA_DIR/messaging/slack/interface.py" config \
    --set-channel "$SLACK_CHANNEL" \
    --set-channel-id "$SLACK_CHANNEL_ID"
echo "  ✓ Slack channel set to: $SLACK_CHANNEL ($SLACK_CHANNEL_ID)"

if [[ -n "$SLACK_WORKSPACE_ID" ]]; then
    python "$NINJA_DIR/messaging/slack/interface.py" config \
        --set-workspace-id "$SLACK_WORKSPACE_ID"
    echo "  ✓ Slack workspace ID set to: $SLACK_WORKSPACE_ID"
fi

python "$NINJA_DIR/messaging/slack/interface.py" config --set-agent "$SLACK_AGENT"
echo "  ✓ Slack agent set to: $SLACK_AGENT (ninja)"
