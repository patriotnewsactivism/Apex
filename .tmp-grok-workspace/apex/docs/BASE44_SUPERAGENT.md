# Base44 Superagent Connector

APEX can delegate bounded work to the Base44 Superagent with agent id `6a515f4e071e32fc10378575` through the registered `base44_superagent` tool.

The connector is optional and registers only when `BASE44_SUPERAGENT_API_KEY` is present in the server environment. The API key is never stored in source or returned by the tool.

## Configuration

```text
BASE44_SUPERAGENT_API_KEY=<rotated server-side secret>
BASE44_SUPERAGENT_ID=6a515f4e071e32fc10378575
BASE44_SUPERAGENT_TIMEOUT_MS=90000
```

Any key that has appeared in chat, screenshots, logs, or source control must be rotated before production use.

## Agent tool

`base44_superagent` accepts:

- `task` — the complete task to delegate.
- `conversationId` — optional; continue an existing Base44 thread rather than creating a new one.
- `fileUrls` — optional public file URLs to attach.
- `timeoutMs` — optional bounded wait, maximum 120 seconds.

The connector creates a conversation when needed, posts the user task, polls until a new assistant message is present, and returns `conversationId`, `messageId`, and `content`. APEX can retain the conversation id for follow-up work or omit it when an isolated second opinion is preferable.
