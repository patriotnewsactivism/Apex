# Base44 Superagent Connector

APEX can delegate bounded work to the **Hank Vance** Base44 Superagent (`6aca4e7c517f3ccfce4a2df3`) through the registered `base44_superagent` tool. Hank is the investigative-journalist correspondent of The Vance Desk; the connector routes research, verification and evidence-package work to him.

The connector is optional and registers only when `BASE44_SUPERAGENT_API_KEY` is present in the server environment. The API key is never stored in source or returned by the tool.

## Configuration

```text
BASE44_SUPERAGENT_API_KEY=<rotated server-side secret>
BASE44_SUPERAGENT_ID=6aca4e7c517f3ccfce4a2df3
BASE44_SUPERAGENT_TIMEOUT_MS=90000
```

The key is a Base44 **personal access token** owned by a workspace editor. Base44 refuses the legacy `api_key` request header (`InvalidAccessTokenError: A personal access token must be sent as an Authorization Bearer token`), so the connector sends it as `Authorization: Bearer <token>`. A workspace API key, or a read-only key, is not accepted.

Any key that has appeared in chat, screenshots, logs, or source control must be rotated before production use.

## Agent tool

`base44_superagent` accepts:

- `task` — the complete task to delegate.
- `conversationId` — optional; continue an existing Base44 thread rather than creating a new one.
- `fileUrls` — optional public file URLs to attach.
- `timeoutMs` — optional bounded wait, maximum 120 seconds.

The connector creates a conversation when needed, posts the user task, polls until a new assistant message is present, and returns `conversationId`, `messageId`, and `content`. APEX can retain the conversation id for follow-up work or omit it when an isolated second opinion is preferable.

## Creating a new Superagent

`POST https://app.base44.com/api/agents` with the personal access token as a Bearer header creates a Superagent that the token owns:

```bash
curl -X POST https://app.base44.com/api/agents \
  -H "Authorization: Bearer $BASE44_SUPERAGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hank Vance","description":"..."}'
```

The response `id` is the Superagent id, and it is also the app id used by the conversation endpoints. Cloudflare blocks this POST from a plain datacenter `curl` (HTTP 403, "Sorry, you have been blocked"); the call succeeds from a browser context, so create agents from the Base44 UI or a browser session.

## Verification

Delegating a task to Hank and reading back the thread is the end-to-end check: the conversation at `/api/agents/<id>/conversations/<conversation_id>` must show the posted `role: user` message followed by a new `role: assistant` reply written in Hank's voice.
