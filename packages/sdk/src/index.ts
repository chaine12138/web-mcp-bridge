/**
 * Browser SDK for web-mcp-bridge.
 *
 * Entry point is the `createAgentTool` factory. It:
 *   1. Validates options synchronously (throws InvalidAgentToolOptionsError).
 *   2. Enforces a single-instance-per-runtime guarantee
 *      (throws AgentToolAlreadyInitializedError on second call).
 *   3. Attaches the instance to `window.agent_tool` (or `globalThis.agent_tool`
 *      on non-DOM runtimes) unless `autoAttachToWindow` is explicitly `false`.
 *
 * Hosts MUST register tools via `window.agent_tool.registerTool(...)` — the SDK
 * does NOT auto-scan, reflect, or otherwise derive tool lists.
 */

import { AgentToolImpl, type AgentTool, type AgentToolOptions } from './agent-tool.js';
import {
  AgentToolAlreadyInitializedError,
  InvalidAgentToolOptionsError,
} from './errors.js';

export type {
  AgentTool,
  AgentToolOptions,
  AgentToolEvents,
} from './agent-tool.js';
export type { ToolDefinition } from './tool-registry.js';
export {
  AgentToolError,
  AgentToolAlreadyInitializedError,
  InvalidAgentToolOptionsError,
  DuplicateToolError,
  AuthFailedError,
  VersionMismatchError,
} from './errors.js';

/**
 * Global augmentation so hosts can refer to `window.agent_tool` with proper typing.
 * Consumers pick the import up transparently when they import this module.
 */
declare global {
  interface Window {
    agent_tool?: AgentTool;
  }
  // eslint-disable-next-line no-var
  var agent_tool: AgentTool | undefined;
}

const GLOBAL_KEY = 'agent_tool' as const;

function getGlobalHost(): Record<string, unknown> {
  if (typeof globalThis !== 'undefined') return globalThis as unknown as Record<string, unknown>;
  // Defensive: ancient bundlers. In practice globalThis is always defined.
  return {} as Record<string, unknown>;
}

let singleton: AgentTool | undefined;

export function createAgentTool(options: AgentToolOptions): AgentTool {
  if (singleton) {
    throw new AgentToolAlreadyInitializedError();
  }
  // Validation happens inside the constructor via validateOptions().
  // We re-run it here via a throwaway construction to keep a clear order.
  const resolved = resolveAndValidate(options);
  const instance = new AgentToolImpl(resolved, options.wsFactory);
  singleton = instance;

  if (resolved.autoAttachToWindow) {
    const g = getGlobalHost();
    if (g[GLOBAL_KEY] !== undefined) {
      // Someone else claimed the slot — throw instead of silently overwriting.
      singleton = undefined;
      throw new AgentToolAlreadyInitializedError(
        'globalThis.agent_tool is already defined by another module'
      );
    }
    g[GLOBAL_KEY] = instance;
  }

  return instance;
}

/**
 * Escape hatch primarily for tests to drop the singleton. Not part of the
 * documented public API; intentionally left out of `AgentTool`.
 */
export function __resetAgentToolForTests(): void {
  singleton = undefined;
  const g = getGlobalHost();
  if (g[GLOBAL_KEY] !== undefined) delete g[GLOBAL_KEY];
}

// --- internal helpers ------------------------------------------------------

function resolveAndValidate(opts: AgentToolOptions): {
  appId: string;
  endpoint: string;
  token: string;
  targetId?: string;
  instanceId: string;
  includeErrorStack: boolean;
  autoAttachToWindow: boolean;
} {
  if (!opts || typeof opts !== 'object') {
    throw new InvalidAgentToolOptionsError('options object is required');
  }
  if (typeof opts.appId !== 'string' || opts.appId.length === 0) {
    throw new InvalidAgentToolOptionsError('options.appId must be a non-empty string');
  }
  if (typeof opts.endpoint !== 'string' || !/^wss?:\/\//.test(opts.endpoint)) {
    throw new InvalidAgentToolOptionsError(
      'options.endpoint must be a ws:// or wss:// URL'
    );
  }
  if (typeof opts.token !== 'string' || opts.token.length === 0) {
    throw new InvalidAgentToolOptionsError('options.token must be a non-empty string');
  }
  if (opts.targetId !== undefined && (typeof opts.targetId !== 'string' || opts.targetId.length === 0)) {
    throw new InvalidAgentToolOptionsError('options.targetId, if provided, must be a non-empty string');
  }
  return {
    appId: opts.appId,
    endpoint: opts.endpoint,
    token: opts.token,
    targetId: opts.targetId,
    instanceId: opts.instanceId ?? randomInstanceId(),
    includeErrorStack: opts.includeErrorStack ?? false,
    autoAttachToWindow: opts.autoAttachToWindow ?? true,
  };
}

function randomInstanceId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof (crypto as Crypto).randomUUID === 'function'
  ) {
    return (crypto as Crypto).randomUUID();
  }
  return `inst-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
