import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  HEALTH_TOOL_NAME,
  PROTOCOL_VERSION,
  TARGET_ROUTING_HINT,
  TOOL_NAMESPACE_SEP,
} from 'web-mcp-shared';
import type { Logger } from './logger.js';
import type { SessionRegistry } from './registry.js';
import type { CallRouter } from './router.js';

/**
 * Thin adapter between the MCP SDK `Server` and the SessionRegistry + CallRouter.
 * Also exposes a built-in `__bridge__health` tool that works without any SDK session.
 */

export interface McpServerOptions {
  registry: SessionRegistry;
  router: CallRouter;
  logger: Logger;
  startedAt: number;
  /**
   * Maximum time (ms) the very first `tools/list` waits for browser sessions
   * to register their tools before responding. Avoids handing the MCP client
   * a stale snapshot containing only `__bridge__health`. Defaults to 3000.
   */
  firstListWarmupMs?: number;
}

export class McpBridgeServer {
  private readonly server: Server;
  private transport?: StdioServerTransport;
  private firstListResolved = false;
  private readonly firstListReady: Promise<void>;

  constructor(private readonly opts: McpServerOptions) {
    this.server = new Server(
      { name: 'web-mcp-bridge', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } }
    );

    // Warm-up window: the first tools/list call (issued by the MCP client at
    // connect time) waits up to `firstListWarmupMs` for at least one host
    // session to register tools. After that the promise stays resolved so all
    // subsequent list calls return immediately.
    const warmupMs = this.opts.firstListWarmupMs ?? 3000;
    this.firstListReady = new Promise<void>((resolve) => {
      const done = (reason: string): void => {
        if (this.firstListResolved) return;
        this.firstListResolved = true;
        this.opts.logger.info('first_list_ready', { reason });
        resolve();
      };
      const timer = setTimeout(() => done('timeout'), warmupMs);
      const unsubscribe = this.opts.registry.onListChanged(() => {
        if (this.opts.registry.listVisibleTools().length > 0) {
          clearTimeout(timer);
          unsubscribe();
          done('tools_registered');
        }
      });
    });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.firstListResolved) {
        await this.firstListReady;
      }
      const hostTools = this.opts.registry.listVisibleTools();
      return {
        tools: [
          {
            name: HEALTH_TOOL_NAME,
            description:
              'Return bridge stats (sessions, tools, uptime). ' +
              '返回结果中的 `targets` 字段以 `{ "appId": ["targetId1", "targetId2", ...] }` 的格式列出各应用当前在线的所有 targetId。' +
              ' 如果用户需要调用某个应用下特定业务对象（如某订单、某页面）的工具，请先调用此工具获取可用 targetId 列表，' +
              '然后在调用对应业务工具时通过 `arguments._bridge_meta.targetId` 传入目标 ID。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          ...hostTools.map((t) => ({
            name: t.fqName,
            description: t.description + TARGET_ROUTING_HINT,
            inputSchema: t.inputSchema,
          })),
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const fqName = req.params.name;
      const { args, targetId } = extractBridgeMeta(req.params.arguments ?? {});

      if (fqName === HEALTH_TOOL_NAME) {
        const stats = this.opts.registry.stats();
        const result: any = {
          sessions: stats.sessions,
          tools: stats.tools,
          uptimeMs: Date.now() - this.opts.startedAt,
          protocolVersion: PROTOCOL_VERSION,
        };
        // Include targets info if available
        if (stats.targets) {
          result.targets = stats.targets;
        }
        return this.toMcpSuccess(result);
      }

      // Reject names lacking the namespace separator early.
      if (!fqName.includes(TOOL_NAMESPACE_SEP)) {
        return this.toMcpError('UNKNOWN_TOOL', `unknown tool: ${fqName}`);
      }

      const resolved = this.opts.registry.resolveSessionForFqName(fqName, targetId);
      if (!resolved) {
        return this.toMcpError('UNKNOWN_TOOL', `unknown tool: ${fqName}`);
      }

      const outcome = await this.opts.router.call(
        resolved.handle,
        fqName,
        resolved.toolName,
        args
      );
      return outcome.ok
        ? this.toMcpSuccess(outcome.data)
        : this.toMcpError(outcome.error.code, outcome.error.message);
    });

    // Wire tool list changes.
    this.opts.registry.onListChanged(() => {
      void this.server.sendToolListChanged().catch((err) => {
        this.opts.logger.warn('send_list_changed_failed', {
          message: (err as Error).message,
        });
      });
    });
  }

  async start(): Promise<void> {
    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
    this.opts.logger.info('mcp_ready');
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.server.close();
      this.transport = undefined;
    }
  }

  private toMcpSuccess(data: unknown): {
    content: Array<{ type: 'text'; text: string }>;
  } {
    return {
      content: [
        {
          type: 'text',
          text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  private toMcpError(
    code: string,
    message: string
  ): {
    isError: true;
    content: Array<{ type: 'text'; text: string }>;
  } {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ code, message }),
        },
      ],
    };
  }
}

// --- Internal helpers ------------------------------------------------------

interface ExtractedBridgeMeta {
  args: Record<string, unknown>;
  targetId?: string;
}

/**
 * Extract routing metadata from arguments._bridge_meta and strip it.
 * MCP SDK validates _meta strictly (only allows progressToken/related_task),
 * so we use _bridge_meta in arguments which is declared in the tool's inputSchema.
 */
function extractBridgeMeta(raw: unknown): ExtractedBridgeMeta {
  const args = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
  let targetId: string | undefined;

  if ('_bridge_meta' in args) {
    const bridgeMeta = args._bridge_meta as Record<string, unknown>;
    if (bridgeMeta && typeof bridgeMeta === 'object' && 'targetId' in bridgeMeta) {
      targetId = bridgeMeta.targetId as string;
    }
    // Strip _bridge_meta so handlers never see it.
    delete args._bridge_meta;
  }

  return { args, targetId };
}
