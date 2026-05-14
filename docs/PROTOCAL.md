# web-page-mcp-bridge Protocol v1

**Status**: frozen (v1). Breaking changes require bumping `PROTOCOL_VERSION` and negotiating at handshake time.

## Transport

- Single WebSocket connection per browser tab.
- Bridge binds `ws://127.0.0.1:<port>` only.
- Frames are UTF-8 JSON objects — one message per frame.

## Handshake

1. Client opens WS → sends `hello` within 2 s, otherwise bridge closes.
2. Bridge validates `token` and `protocolVersion`.
3. On success, bridge replies `hello_ack`; the session is now live.
4. On failure, bridge sends `error` with code `AUTH_FAILED` or `VERSION_MISMATCH`, then closes.

```json
// client → bridge
{ "type": "hello", "appId": "lowcode-demo", "instanceId": "uuid",
  "targetId": "order-123", "token": "shared-secret", "protocolVersion": 1 }

// bridge → client
{ "type": "hello_ack", "sessionId": "uuid", "protocolVersion": 1 }
```

**Optional `targetId`**: Identifies the business object this session operates on (e.g., `"order-123"`). When multiple sessions share the same `appId` but have different `targetId` values, the agent can route tool calls to a specific session via `arguments._bridge_meta.targetId` (see Tool invocation below).

## Tool registration

Hosts register through `window.agent_tool.registerTool(...)`. The SDK converts the Zod schema to JSON Schema and sends:

```json
{ "type": "tools/register",
  "tools": [
    { "name": "updateComponent",
      "description": "…",
      "inputSchema": { "type": "object", "properties": { … } } }
  ] }
```

Unregistration:

```json
{ "type": "tools/unregister", "names": ["updateComponent"] }
```

After any register/unregister the bridge emits an MCP `notifications/tools/list_changed` to the agent.

## Tool invocation

### Agent → Bridge (MCP CallTool)

The agent includes an optional `_bridge_meta.targetId` in `arguments` to route the call to a specific browser session:

```json
{
  "name": "lowcode-demo__getSelectedNodeId",
  "arguments": {
    "_bridge_meta": { "targetId": "order-123" }
  }
}
```

**Routing behavior**:
- If `arguments._bridge_meta.targetId` is provided, the bridge routes to the session with matching `(appId, targetId)`.
- If omitted, the bridge routes to the most recent session for that `appId` (legacy behavior).
- The bridge extracts and strips `_bridge_meta` before forwarding to the SDK — **host tool handlers never see `_bridge_meta`**.

### Bridge → client:

```json
{ "type": "tool/call", "id": "req-uuid",
  "name": "updateComponent", "arguments": { "id": "c1", "props": {} } }
```

Client → bridge (success):

```json
{ "type": "tool/result", "id": "req-uuid", "ok": true, "data": { … } }
```

Client → bridge (failure):

```json
{ "type": "tool/result", "id": "req-uuid", "ok": false,
  "error": { "code": "HANDLER_ERROR", "message": "…", "name": "TypeError" } }
```

The bridge enforces a 30 s timeout per `tool/call`. Late `tool/result` frames are silently dropped.

## Error codes (frozen)

| Code | Emitted by | Meaning |
| --- | --- | --- |
| `AUTH_FAILED` | bridge | Bad token during handshake. |
| `VERSION_MISMATCH` | bridge | Client `protocolVersion` > bridge supports. |
| `INVALID_MESSAGE` | bridge | Payload failed JSON / schema validation. |
| `INVALID_ARGUMENT` | SDK | Arguments failed the tool's Zod schema. |
| `UNKNOWN_TOOL` | bridge / SDK | Tool name not registered. |
| `HANDLER_ERROR` | SDK | Tool handler threw or rejected. |
| `TOOL_UNAVAILABLE` | bridge | Session dropped before `tool/result`. |
| `TIMEOUT` | bridge | `tool/call` exceeded 30 s. |

## Heartbeat

- Either side MAY emit `{"type":"ping"}`; the peer MUST reply `{"type":"pong"}`.
- If no frame (ping/pong/data) is received for 30 s, the peer MUST close.
- SDK default: ping every 15 s.

## Multi-instance policy

### Without targetId (legacy)
If two tabs share the same `appId` without specifying `targetId`, the bridge exposes only the **latest** session's tool set to the agent. The older session remains connected but its tools are hidden.

### With targetId (recommended for multi-window)
When sessions specify different `targetId` values, the bridge maintains separate routing indexes. The agent can target a specific session by including `_bridge_meta.targetId` in `arguments`. Tools from different `targetId` sessions are deduplicated in the agent's tool list (same `appId__toolName` appears once).

**Example scenario**:
- Tab A: `appId="lowcode-demo", targetId="order-123"`
- Tab B: `appId="lowcode-demo", targetId="order-456"`
- Agent sees: `lowcode-demo__getSelectedNodeId` (one tool)
- Agent calls with `arguments._bridge_meta.targetId="order-456"` → routed to Tab B

## Namespacing

Tools are exposed to the MCP agent as `<appId>__<toolName>` (double underscore). The bridge strips the `<appId>__` prefix before forwarding a `tool/call` to the host.

## Soft offline window

When a session disconnects, the bridge keeps its tool set visible for 2 s to absorb page reloads. After the window elapses the tools are removed and `list_changed` is notified.
