# Communication Protocol Overview

- **Keep messages SHORT** — 2-4 sentences max. No walls of text. Be direct.
- **Reply in threads** — If someone asks you a question or requests an update, reply in the thread (`-t thread_ts`), not as a new message.

**Workflow:**
1. Read Slack for new requests or context
2. Do your work (browser tasks, research, screenshots, data extraction)
3. Post results to Slack (short messages, attach screenshots/files)
4. Commit any code changes to git

**Slack Commands:**
- `python messaging/slack/interface.py read -l 50` - Read recent messages
- `python messaging/slack/interface.py say "message"` - Post updates
- `python messaging/slack/interface.py upload <file> --title "..."` - Upload file/screenshot
- `python messaging/slack/interface.py config` - Check configuration


# Slack Interface CLI

A powerful command-line tool and Python API for interacting with Slack workspaces.

## Features

- 🔑 **Automatic Token Detection** - Reads tokens from `/dev/shm/mcp-token` or environment variables
- 📢 **Default Channel Support** - Configure a default channel for quick messaging
- 🤖 **Agent Avatars** - Send messages as specific agents with custom avatars
- 📎 **File Uploads** - Upload files to channels (requires `files:write` scope)
- 😀 **Reactions** - Add or remove emoji reactions on a message
- 🐍 **Python API** - Use as a library in your Python scripts
- 🔍 **Scope Detection** - Shows available permissions for each token type
- 💬 **Full Slack Operations** - Send messages, list channels/users, get history, and more

## Installation

The tool is included in this repository. No additional installation required.

```bash
# Make executable (optional)
chmod +x messaging/slack/interface.py
```

### Dependencies

```bash
pip install requests
```

## Quick Start

### 1. Connect Slack

Click the **'Connect'** button in the chat interface to link your Slack workspace. This automatically provides the necessary authentication tokens.

### 2. Set Default Channel and Agent

```bash
# Set your default communication channel
python messaging/slack/interface.py config --set-channel "#your-channel"

# Set your default agent (REQUIRED for 'say' command)
python messaging/slack/interface.py config --set-agent ninja
```

### 3. Send Messages

```bash
# Send as configured agent to default channel
python messaging/slack/interface.py say "Hello team!"

# Reply in a thread
python messaging/slack/interface.py say "Thread reply" -t "1234567890.123456"
```

> **Sandbox URL auto-conversion:** Any `0.0.0.0:<port>` in message text is automatically rewritten to the public sandbox URL before sending. When sharing links to local services (dashboards, servers), use `0.0.0.0:<port>` form — no manual URL lookup needed.

### 4. Upload Files

```bash
# Upload file to default channel
python messaging/slack/interface.py upload design.png

# Upload with comment
python messaging/slack/interface.py upload mockup.png -m "New design ready for review!"

# Upload to specific channel
python messaging/slack/interface.py upload report.pdf -c "#reports" --title "Q4 Report"
```

## Agents

The `say` command **requires an agent identity** to be configured first.

| Agent   | Role                      | Emoji | Color  |
| ------- | ------------------------- | ----- | ------ |
| `ninja` | Browser Automation Agent  | 🥷    | Purple |

```bash
# List all agents
python messaging/slack/interface.py agents

# Configure your agent identity (do this first!)
python messaging/slack/interface.py config --set-agent ninja

# Then send messages as that agent
python messaging/slack/interface.py say "Sprint planning at 2pm"
```

## Configuration

### Config File Location

The configuration is stored at `~/.agent_settings.json`:

```json
{
  "default_channel": "#your-channel",
  "default_channel_id": "C0AAAAMBR1R",
  "default_agent": "ninja",
  "workspace": "YourWorkspace"
}
```

### Setting Defaults

```bash
# Set default channel (by name)
python messaging/slack/interface.py config --set-channel "#your-channel"

# Set default channel (by ID)
python messaging/slack/interface.py config --set-channel "C0AAAAMBR1R"

# Set default agent (REQUIRED before using 'say')
python messaging/slack/interface.py config --set-agent ninja

# View current config
python messaging/slack/interface.py config
```

### Custom Config File

```bash
python messaging/slack/interface.py -C /path/to/config.json config
```

## CLI Commands

### Configuration

```bash
# Show current configuration
python messaging/slack/interface.py config

# Set default channel
python messaging/slack/interface.py config --set-channel "#channel-name"

# Set default agent
python messaging/slack/interface.py config --set-agent ninja
```

### Messaging with Agents

```bash
# Send as configured agent to default channel
python messaging/slack/interface.py say "Your message here"

# Reply in thread
python messaging/slack/interface.py say "Thread reply" -t "1234567890.123456"
```

### File Uploads

```bash
# Upload file to default channel
python messaging/slack/interface.py upload path/to/file.png

# Upload with comment
python messaging/slack/interface.py upload design.png -m "New design for review"

# Upload with title
python messaging/slack/interface.py upload report.pdf --title "Monthly Report"

# Upload to specific channel
python messaging/slack/interface.py upload data.csv -c "#data-team"

# Upload as thread reply
python messaging/slack/interface.py upload screenshot.png -t "1234567890.123456"
```

### Reactions

```bash
# React to a message in the default channel (default emoji: 🥷)
python messaging/slack/interface.py react "1234567890.123456"

# React with a specific emoji (name or character)
python messaging/slack/interface.py react "1234567890.123456" eyes

# React to a message in a specific channel
python messaging/slack/interface.py react "1234567890.123456" ✅ -c "#general"

# Remove the agent's reaction (same arguments as react; removing an absent one succeeds)
python messaging/slack/interface.py unreact "1234567890.123456" eyes
```

### Reading Messages

```bash
# Read from default channel (last 50 messages)
python messaging/slack/interface.py read

# Read specific number of messages
python messaging/slack/interface.py read -l 100

# Read from specific channel
python messaging/slack/interface.py read -c "#general"
```

### Channel Operations

```bash
# List all channels
python messaging/slack/interface.py channels

# List only public channels
python messaging/slack/interface.py channels -t public_channel

# Save to file
python messaging/slack/interface.py channels -o channels.json

# Get channel info
python messaging/slack/interface.py info "#channel-name"

# Join a channel
python messaging/slack/interface.py join "#channel-name"

# Create a channel
python messaging/slack/interface.py create new-channel-name
python messaging/slack/interface.py create private-channel --private
```

### User Operations

```bash
# List all users
python messaging/slack/interface.py users

# Include bots and deleted users
python messaging/slack/interface.py users --all

# Save to file
python messaging/slack/interface.py users -o users.json
```

### History

```bash
# Get channel history (default: 20 messages)
python messaging/slack/interface.py history "#channel-name"

# Get more messages
python messaging/slack/interface.py history "#channel-name" -l 50
```

### Token Information

```bash
# Show available scopes for each token
python messaging/slack/interface.py scopes
```

## Python API

### Basic Usage

```python
from slack_interface import SlackInterface

# Initialize
slack = SlackInterface()

# Check connection
if not slack.is_connected:
    print("Please connect Slack first!")
    exit(1)

# Send to default channel
slack.say("Hello team!")

# Send with custom username and icon
slack.say("Hello!", username="Ninja", icon_url="https://example.com/ninja.png")
```

### File Upload Example

```python
from slack_interface import SlackInterface

slack = SlackInterface()

# Upload a file
result = slack.upload_file(
    "designs/mockup.png",
    title="Homepage Mockup v2",
    comment="Updated design based on feedback"
)

if result.get('ok'):
    print(f"File uploaded: {result['file']['permalink']}")
else:
    print(f"Upload failed: {result.get('error')}")
```

### Full API Example

```python
from slack_interface import SlackInterface

# Initialize
slack = SlackInterface()

# Check connection
if not slack.is_connected:
    print("Please connect Slack first!")
    exit(1)

# Get default channel
print(f"Default channel: {slack.default_channel}")

# Set default channel
slack.set_default_channel("#your-channel")

# List channels
channels = slack.list_channels()
for ch in channels:
    print(f"#{ch['name']} - {ch.get('num_members', 0)} members")

# List users
users = slack.list_users()
for user in users:
    print(f"@{user['name']} - {user.get('real_name', 'N/A')}")

# Get channel history
messages = slack.get_history(limit=10)
for msg in messages:
    print(f"{msg.get('user')}: {msg.get('text')}")

# Send message with custom identity
result = slack.say(
    "Hello from the API!",
    username="Ninja",
    icon_url="https://sites.super.betamyninja.ai/.../ninja.png"
)
if result.get('ok'):
    print(f"Message sent! ts={result['ts']}")

# Upload a file
result = slack.upload_file(
    "report.pdf",
    title="Weekly Report",
    comment="Here's the weekly status report"
)

# Join a channel
slack.join_channel("#new-channel")

# Create a channel
slack.create_channel("my-new-channel", is_private=False)
```

### Error Handling

```python
from slack_interface import SlackInterface

slack = SlackInterface()

try:
    slack.say("Hello!")
except RuntimeError as e:
    print(f"Connection error: {e}")
    print("Please click 'Connect' button to link Slack")
except ValueError as e:
    print(f"Configuration error: {e}")
    print("Set default channel with: slack.set_default_channel('#channel')")
```

## Token Sources

Tokens are loaded in this order of priority:

1. **Cached config** (`~/.agent_settings.json`) — persisted from first connection
2. **`/dev/shm/mcp-token`** — Auto-populated when you click 'Connect' in chat
3. **Environment Variable**: `SLACK_BOT_TOKEN` or `SLACK_MCP_XOXB_TOKEN`

> ⚠️ **Only bot tokens (xoxb-\*) are supported.** User tokens (xoxp-\*) are rejected with an error.

> **Auto-refresh:** On `token_expired` or `invalid_auth` errors the client automatically re-reads `/dev/shm/mcp-token` and updates `~/.agent_settings.json`. No agent intervention needed; this is transparent to callers.

### Manual Token Setup

If you need to set the bot token manually:

```bash
export SLACK_BOT_TOKEN='xoxb-your-bot-token'
```

## Token Types & Scopes

### Bot Token (xoxb-\*) — ONLY SUPPORTED TYPE

- Acts as the bot/app itself
- Limited to channels where bot is invited
- Supports custom username and icon in messages
- Scopes are configured in app settings

### Required Scopes by Feature

| Feature                | Required Scopes    |
| ---------------------- | ------------------ |
| **Basic Operations**   |                    |
| List channels          | `channels:read`    |
| Read messages          | `channels:history` |
| Send messages          | `chat:write`       |
| List users             | `users:read`       |
| **File Operations**    |                    |
| Upload files           | `files:write`      |
| Read file info         | `files:read`       |
| **Channel Management** |                    |
| Join channels          | `channels:join`    |
| Create channels        | `channels:manage`  |
| **Private Channels**   |                    |
| List private channels  | `groups:read`      |
| Read private messages  | `groups:history`   |

## Troubleshooting

### "Slack Not Connected" Error

```
======================================================================
❌ SLACK NOT CONNECTED
======================================================================

No Slack tokens found. Please connect your Slack workspace first.

👉 To connect Slack:
   Click the 'Connect' button in the chat interface to link your
   Slack workspace.
======================================================================
```

**Solution**: Click the 'Connect' button in the chat interface.

### "No agent specified" Error

```
❌ No agent specified and no default agent configured

🤖 The 'say' command requires an agent identity.

💡 To configure your agent:
   python messaging/slack/interface.py config --set-agent ninja
```

**Solution**: Set a default agent:

```bash
python messaging/slack/interface.py config --set-agent ninja
```

### "No default channel configured" Error

**Solution**: Set a default channel:

```bash
python messaging/slack/interface.py config --set-channel "#your-channel"
```

### "channel_not_found" Error

The channel might be private or the bot isn't a member.

**Solution**:

```bash
# Join the channel first
python messaging/slack/interface.py join "#channel-name"
```

### "missing_scope" Error

The token doesn't have required permissions.

**Solution**: Check available scopes:

```bash
python messaging/slack/interface.py scopes
```

### "files:write" Scope Missing (File Uploads)

File uploads require the `files:write` scope.

**Solution**:

1. Go to your Slack app settings at https://api.slack.com/apps
2. Navigate to "OAuth & Permissions"
3. Add `files:write` to Bot Token Scopes
4. Reinstall the app to your workspace

## Examples

### Agent Communication Setup

```bash
# 1. Connect Slack (click Connect button in chat)

# 2. Set default channel for agent communication
python messaging/slack/interface.py config --set-channel "#your-channel"

# 3. Set default agent
python messaging/slack/interface.py config --set-agent ninja

# 4. Verify setup
python messaging/slack/interface.py config

# 5. Test messaging
python messaging/slack/interface.py say "🥷 Ninja is online and ready!"
```

### Multi-Agent Communication

Each agent session should configure its own identity:

```bash
# Ninja's session
python messaging/slack/interface.py config --set-agent ninja
python messaging/slack/interface.py say "🥷 Task complete - search results posted"
```

### File Upload Workflow

```bash
# Upload design mockup with comment
python messaging/slack/interface.py upload designs/homepage_v2.png \
    -m "Updated homepage design based on feedback" \
    --title "Homepage Mockup v2"

# Upload test report
python messaging/slack/interface.py upload reports/test_results.pdf \
    -c "#qa-team" \
    --title "Sprint 1 Test Results"
```

### Channel Monitor Script

```python
from slack_interface import SlackInterface

slack = SlackInterface()

# Get recent messages from default channel
messages = slack.get_history(limit=5)

print("Recent messages:")
for msg in reversed(messages):
    user = msg.get('user', 'unknown')
    text = msg.get('text', '')[:50]
    print(f"  <{user}>: {text}")
```

## API Reference

### SlackInterface Class

| Method                                                             | Description                 |
| ------------------------------------------------------------------ | --------------------------- |
| `say(message, channel, thread_ts, username, icon_emoji, icon_url)` | Send a message              |
| `upload_file(file_path, channel, title, comment, thread_ts)`       | Upload a file               |
| `react(ts, emoji, channel)`                                        | Add an emoji reaction       |
| `unreact(ts, emoji, channel)`                                      | Remove the agent's reaction |
| `get_history(channel, limit)`                                      | Get channel message history |
| `list_channels(types)`                                             | List all channels           |
| `list_users()`                                                     | List all users              |
| `join_channel(channel)`                                            | Join a channel              |
| `create_channel(name, is_private)`                                 | Create a new channel        |
| `set_default_channel(channel)`                                     | Set default channel         |
| `get_scopes()`                                                     | Get available OAuth scopes  |

### Properties

| Property               | Description                                  |
| ---------------------- | -------------------------------------------- |
| `is_connected`         | Boolean - True if tokens are available       |
| `default_channel`      | Default channel ID or name                   |
| `default_channel_name` | Default channel name (e.g., "#your-channel") |

## License

MIT License - NinjaTech AI
