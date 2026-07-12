# Apex Event Bus

The Apex Event Bus is the communication backbone of the agent hierarchy. Every agent action—task creation, delegation, completion, approval requests—emits events that other agents, the API server, and websocket clients can subscribe to.

## Architecture

```
BaseAgent → emitApexEvent() → EventEmitter → {
  ├── WebSocket broadcast (real-time UI updates)
  ├── Agent subscribers (reactive triggers)
  ├── Audit log (persistent record)
  └── External integrations (webhooks, Slack, etc.)
}
```

## Event Types

| Type | Emitted By | Description |
|------|-----------|-------------|
| `goal:created` | CEO | A new goal has been created |
| `task:created` | Any agent | A new task has been assigned |
| `task:delegated` | Any agent | A task has been delegated to another agent |
| `task:started` | Specialist | A specialist has begun working |
| `task:completed` | Specialist | A specialist has finished |
| `approval:requested` | Any agent | Human approval is needed |
| `approval:resolved` | API server | Human has approved/rejected |

## Usage

### Emitting events
```typescript
import { emitApexEvent } from '@workspace/core';

emitApexEvent({
  type: 'task:completed',
  agentId: 'greeter',
  message: 'Greeting delivered successfully',
});
```

### Subscribing to events
```typescript
import { apexEventBus } from '@workspace/core';

apexEventBus.on('event', (event) => {
  console.log(`[${event.type}] ${event.message}`);
});
```

### WebSocket integration
The API server automatically broadcasts all events to connected WebSocket clients. Any frontend can subscribe:

```javascript
const ws = new WebSocket('ws://localhost:3001');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data);
};
```

## Human-in-the-Loop Approvals

When an agent needs human approval, it emits `approval:requested`. The approval appears in the API server's `/api/approvals` endpoint. A human can approve or reject via:

```
POST /api/approvals/:id/approve  { note: "Looks good" }
POST /api/approvals/:id/reject   { note: "Needs changes" }
```

The resolution is broadcast via WebSocket as `approval:resolved`.
