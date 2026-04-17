## A2A (agent-to-agent) bridge

This adds a small **A2A network** surface to the BrowserOS server so an external “peer agent” can:

- **Watch a chat conversation** (SSE) for new user messages
- **Send messages into the same conversation** (via the existing `/chat` endpoint, proxied over WebSocket)

### Security

If you set `BROWSEROS_A2A_KEY`, clients must pass it as `x-a2a-key`.

```bash
export BROWSEROS_A2A_KEY="dev-secret"
```

### Endpoints

- **Stream user messages** (SSE):
  - `GET /a2a/:conversationId/stream`

- **Proxy chat requests** (WebSocket):
  - `GET /a2a/ws`
  - Client sends JSON:

```json
{ "type": "chat", "request": { "...": "ChatRequest body for POST /chat" } }
```

### Minimal local test (curl)

In one terminal (stream):

```bash
curl -N \
  -H "x-a2a-key: dev-secret" \
  "http://127.0.0.1:9000/a2a/<conversationId>/stream"
```

In another, send a normal UI message from the BrowserOS chat. You should see `user-message` events.

### Minimal peer agent flow

1. Subscribe to `/a2a/:conversationId/stream`
2. On each `user-message`, decide what to reply
3. Post your reply by sending a `chat` frame to `/a2a/ws` (or just POST directly to `/chat`)

