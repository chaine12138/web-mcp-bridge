/**
 * Wire-level protocol constants shared between web-page-mcp-bridge and web-page-mcp-sdk.
 * These are frozen at v1; bumping them requires a PROTOCOL_VERSION change.
 */

export const PROTOCOL_VERSION = 1 as const;

export const DEFAULT_BRIDGE_PORT = 7321 as const;
export const DEFAULT_BRIDGE_HOST = '127.0.0.1' as const;

/** Soft-offline window: keep tools alive for this ms after WS disconnects. */
export const SOFT_OFFLINE_MS = 2000 as const;

/** SDK sends ping every N ms; bridge replies pong. */
export const HEARTBEAT_INTERVAL_MS = 15_000 as const;

/** If no message is received within this window, the peer is considered dead. */
export const PEER_SILENCE_TIMEOUT_MS = 30_000 as const;

/** Default deadline for a single tool/call roundtrip. */
export const TOOL_CALL_TIMEOUT_MS = 30_000 as const;

/** Handler execution timeout inside SDK. */
export const HANDLER_TIMEOUT_MS = 60_000 as const;

/** How long the SDK can wait before sending `hello` after WS opens. */
export const HELLO_TIMEOUT_MS = 2_000 as const;

/** Delimiter used to namespace tool names exposed to the MCP agent. */
export const TOOL_NAMESPACE_SEP = '__' as const;

/** Built-in health-check tool name (always available, no host required). */
export const HEALTH_TOOL_NAME = `__bridge${TOOL_NAMESPACE_SEP}health` as const;

/** Hint appended to every business tool description for multi-instance routing. */
export const TARGET_ROUTING_HINT =
  '\n\n[多实例路由] 如果用户指定了业务对象 ID（如订单号、页面号等），请在调用该工具时通过 `arguments._bridge_meta.targetId` 传入该 ID（例如 `"_bridge_meta": { "targetId": "4223809" }`），而不是放在其他业务字段中。可用 targetId 列表可通过调用 `__bridge__health` 查询（见返回中的 `targets` 字段）。' as const;
