/**
 * Public surface of `web-mcp-bridge` for programmatic use and testing.
 * The production entry point is `cli.ts`.
 */

export { createLogger } from './logger.js';
export type { Logger, LogFields, LogLevel } from './logger.js';

export { SessionRegistry } from './registry.js';
export type {
  SessionHandle,
  FlatTool,
  ListChangedListener,
} from './registry.js';

export { CallRouter } from './router.js';
export type { CallOutcome } from './router.js';

export { WsServer } from './ws-server.js';
export type { WsServerOptions } from './ws-server.js';

export { McpBridgeServer } from './mcp-server.js';
export type { McpServerOptions } from './mcp-server.js';

export { main } from './cli.js';
