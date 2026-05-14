# web-page-mcp-bridge

本地 MCP 服务器，通过本地 WebSocket 将工具调用转发到浏览器内的宿主应用。Agent 只能看到 Web 应用显式注册的工具，而非原始的浏览器操作。

> English version: [README.md](./README.md)

## 包说明

| 包 | 用途 |
| --- | --- |
| [`web-page-mcp-bridge`](./packages/bridge) | Node CLI。一端运行基于 stdio 的 MCP 服务器，另一端运行 localhost 的 WS 服务器。 |
| [`web-page-mcp-sdk`](./packages/sdk) | 浏览器 SDK。暴露 `window.agent_tool.registerTool(...)` 并实现 WS 协议。 |
| [`web-page-mcp-shared`](./packages/shared) | 内部包：协议常量、类型定义、Zod schema。 |

## 整体架构

```
 Agent (Qoder/Claude/…)
        │  基于 stdio 的 MCP
        ▼
  web-page-mcp-bridge  ── WebSocket (127.0.0.1) ──▶  浏览器标签页
        │                                           │
        └─── 聚合工具 ───────────────────────────────┘
                           宿主通过 window.agent_tool.registerTool(...) 注册
```

bridge 不直接操作 DOM，它仅转发宿主显式注册的工具，并把执行结果回传给 Agent。

## 端到端使用

### 1. 启动 bridge

```bash
export WEB_MCP_TOKEN="$(openssl rand -hex 16)"
npx web-page-mcp-bridge --token "$WEB_MCP_TOKEN" --port 7321
```

默认配置：监听 `127.0.0.1`、端口 `7321`、日志级别 `info`。bridge 通过 stdio 暴露 MCP 服务器，同时为浏览器提供 WebSocket 服务器。

### 2. 在 MCP 客户端中接入 bridge

以下是 Qoder 风格的 MCP 配置示例（任何支持 MCP 的 Agent 配置方式都类似）：

```json
{
  "mcpServers": {
    "web-page-mcp-bridge": {
      "command": "npx",
      "args": ["-y", "web-page-mcp-bridge", "--port", "7321"],
      "env": { "WEB_MCP_TOKEN": "<与上文一致的 token>" }
    }
  }
}
```

首次连接时，bridge 会等待至多 3 秒，直到至少一个浏览器会话完成工具注册。这样 Agent 第一次 `tools/list` 就能看到宿主的工具，而不是只有 `__bridge__health`。

### 3. 在宿主页面注册工具

```ts
import { z } from 'zod';
import { createAgentTool } from 'web-page-mcp-sdk';

const agent = createAgentTool({
  appId: 'lowcode-demo',                // 作为工具命名空间
  endpoint: 'ws://127.0.0.1:7321',
  token: import.meta.env.WEB_MCP_TOKEN, // 必须与 bridge 的 token 一致
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

await agent.connect(); // WS 握手成功后 resolve
```

此时 Agent 就能看到 `lowcode-demo__getSelectedNodeId`。后续再调用 `registerTool` 新增工具时，bridge 会推送 `notifications/tools/list_changed`，MCP 客户端自动刷新工具缓存。

### 4. 多窗口路由（Target ID）

当同一应用在多个浏览器窗口打开，且需要操作不同的业务对象时，可以使用 `targetId` 实现精确路由：

```ts
// 窗口 A：操作订单 123
const agentA = createAgentTool({
  appId: 'lowcode-demo',
  targetId: 'order-123',  // 标识当前窗口操作的业务对象
  endpoint: 'ws://127.0.0.1:7321',
  token: import.meta.env.WEB_MCP_TOKEN,
});
await agentA.connect();

// 窗口 B：操作订单 456
const agentB = createAgentTool({
  appId: 'lowcode-demo',
  targetId: 'order-456',  // 不同的业务对象
  endpoint: 'ws://127.0.0.1:7321',
  token: import.meta.env.WEB_MCP_TOKEN,
});
await agentB.connect();
```

Agent 调用时通过 `arguments._bridge_meta.targetId` 指定目标窗口：

```json
{
  "name": "lowcode-demo__getSelectedNodeId",
  "arguments": {
    "_bridge_meta": { "targetId": "order-456" }
  }
}
```

**关键优势**：
- Agent 只看到一份工具（不重复）
- 业务工具 handler 无需任何改动（零侵入）
- Bridge 自动路由到正确的窗口

### 5. 内置健康检查

每个 bridge 实例都会暴露 `__bridge__health`（无需 SDK 会话）。返回 `{ sessions, tools, uptimeMs, protocolVersion }`，便于在任何宿主注册工具之前调试连通性。

## 本地开发

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm --filter @web-mcp/e2e run run
```

## 协议

WebSocket 协议 v1 已冻结，详见 [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)。

## 安全模型

- bridge 仅绑定 `127.0.0.1`，不暴露到局域网。
- 握手需要共享 token。请通过环境变量保存，切勿提交到仓库。
- 宿主工具运行在浏览器中，其影响范围取决于 handler 所触达的 DOM 与应用状态。

## 许可证
Proprietary — © 2026 Aliyun-com. All rights reserved.
