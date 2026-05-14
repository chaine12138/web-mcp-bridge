# web-mcp-bridge

Local MCP server that forwards tool calls to in-browser host applications over a local WebSocket. Agents see the tools your web app explicitly registers — not raw browser operations.

> 中文版：[README.zh-CN.md](./README.zh-CN.md)

## Packages

| Package | Purpose |
| --- | --- |
| [`@web-mcp/bridge`](./packages/bridge) | Node CLI. Runs an MCP stdio server on one side and a localhost WS server on the other. |
| [`@web-mcp/sdk`](./packages/sdk) | Browser SDK. Exposes `window.agent_tool.registerTool(...)` and speaks the WS protocol. |
| [`@web-mcp/shared`](./packages/shared) | Internal: protocol constants, types, Zod schemas. |

## How it fits together

```
 Agent (Qoder/Claude/…)
        │  MCP over stdio
        ▼
  @web-mcp/bridge  ── WebSocket (127.0.0.1) ──▶  Browser tab
        │                                           │
        └─── aggregates tools ──────────────────────┘
                           the host registered via window.agent_tool.registerTool(...)
```

The bridge does not touch the DOM. It forwards the tools each host explicitly registers and relays their results back to the agent.

## End-to-end usage

### 1. Start the bridge

```bash
export WEB_MCP_TOKEN="$(openssl rand -hex 16)"
npx @web-mcp/bridge --token "$WEB_MCP_TOKEN" --port 7321
```

Defaults: bind `127.0.0.1`, port `7321`, log level `info`. The bridge exposes an MCP server over stdio and a WebSocket server for browsers.

### 2. Wire the bridge into your MCP client

Example for a Qoder-style MCP config (any MCP-capable agent works the same way):

```json
{
  "mcpServers": {
    "web-mcp-bridge": {
      "command": "npx",
      "args": ["-y", "@web-mcp/bridge", "--port", "7321"],
      "env": { "WEB_MCP_TOKEN": "<same value as above>" }
    }
  }
}
```

On first connect the bridge waits up to 3 s for at least one browser session to register tools, so the agent's first `tools/list` already includes your host tools instead of just `__bridge__health`.

### 3. Register tools from the host page

```ts
import { z } from 'zod';
import { createAgentTool } from '@web-mcp/sdk';

const agent = createAgentTool({
  appId: 'lowcode-demo',                // becomes the tool namespace
  endpoint: 'ws://127.0.0.1:7321',
  token: import.meta.env.WEB_MCP_TOKEN, // must match the bridge token
});

window.agent_tool!.registerTool({
  name: 'getSelectedNodeId',
  description: '获取当前画布选中节点的组件 id',
  inputSchema: z.object({}),
  handler: () => {
    const node = engine.project.currentDocument?.selection.getTopNodes()[0];
    if (!node) throw new Error('No selection');
    return { id: node.id };
  },
});

await agent.connect(); // resolves once the WS handshake succeeds
```

Your agent now sees `lowcode-demo__getSelectedNodeId`. Adding more tools later just calls `registerTool` again — the bridge pushes a `notifications/tools/list_changed` and the MCP client refreshes its tool cache automatically.

### 4. Multi-window routing (Target ID)

When the same app is open in multiple browser windows and you need to operate on different business objects, use `targetId` for precise routing:

```ts
// Window A: Operating on order 123
const agentA = createAgentTool({
  appId: 'lowcode-demo',
  targetId: 'order-123',  // Identifies the business object for this window
  endpoint: 'ws://127.0.0.1:7321',
  token: import.meta.env.WEB_MCP_TOKEN,
});
await agentA.connect();

// Window B: Operating on order 456
const agentB = createAgentTool({
  appId: 'lowcode-demo',
  targetId: 'order-456',  // Different business object
  endpoint: 'ws://127.0.0.1:7321',
  token: import.meta.env.WEB_MCP_TOKEN,
});
await agentB.connect();
```

The agent specifies the target window via `arguments._bridge_meta.targetId` when calling:

```json
{
  "name": "lowcode-demo__getSelectedNodeId",
  "arguments": {
    "_bridge_meta": { "targetId": "order-456" }
  }
}
```

**Key benefits**:
- Agent sees only one tool (no duplication)
- Business tool handlers require zero changes (non-invasive)
- Bridge automatically routes to the correct window

### 5. Built-in health check

Every bridge instance exposes `__bridge__health` (no SDK session required). It returns `{ sessions, tools, uptimeMs, protocolVersion }` — useful for debugging connectivity before any host has registered tools.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm --filter @web-mcp/e2e run run
```

## Protocol

The WebSocket protocol v1 is frozen in [`docs/PROTOCOL.md`](./docs/PROTOCOL.md).

## Security model

- Bridge binds `127.0.0.1` only — no LAN exposure.
- Handshake requires a shared token. Store it in an env var; never commit it.
- Host tools run in the browser; their blast radius is whatever DOM / app state their handlers touch.

## License
Proprietary — © 2026 Aliyun-com. All rights reserved.
