import {
  HANDLER_TIMEOUT_MS,
  buildErrorPayload,
  type Message,
  type ToolCallMessage,
} from 'web-mcp-shared';
import {
  createConnection,
  type ConnectionHandle,
  type ConnectionOptions,
} from './connection.js';
import { TypedEmitter } from './emitter.js';
import { InvalidAgentToolOptionsError } from './errors.js';
import { ToolRegistry, type ToolDefinition } from './tool-registry.js';

/**
 * Public `AgentTool` instance: created via {@link createAgentTool}, attached to
 * `window.agent_tool`. Hosts MUST register tools exclusively through
 * `window.agent_tool.registerTool(...)`.
 */

export interface AgentToolOptions {
  appId: string;
  endpoint: string;
  token: string;
  targetId?: string;
  instanceId?: string;
  includeErrorStack?: boolean;
  autoAttachToWindow?: boolean;
  /** Injection point for tests. */
  wsFactory?: ConnectionOptions['wsFactory'];
}

export interface AgentToolEvents {
  connected: { sessionId?: string };
  disconnected: { reason: string };
  error: { error: Error };
  toolCallStart: { name: string; requestId: string };
  toolCallEnd: { name: string; requestId: string; ok: boolean; latencyMs: number };
}

export interface AgentTool {
  readonly appId: string;
  readonly targetId?: string;
  readonly instanceId: string;
  registerTool(def: ToolDefinition): void;
  unregisterTool(name: string): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on<K extends keyof AgentToolEvents>(
    event: K,
    handler: (payload: AgentToolEvents[K]) => void
  ): void;
  off<K extends keyof AgentToolEvents>(
    event: K,
    handler: (payload: AgentToolEvents[K]) => void
  ): void;
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

function validateOptions(opts: AgentToolOptions): Required<
  Pick<AgentToolOptions, 'appId' | 'endpoint' | 'token' | 'instanceId' | 'includeErrorStack' | 'autoAttachToWindow'>
> & { targetId?: string } {
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

class AgentToolImpl implements AgentTool {
  readonly appId: string;
  readonly targetId?: string;
  readonly instanceId: string;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly includeErrorStack: boolean;
  private readonly registry = new ToolRegistry();
  private readonly emitter = new TypedEmitter<AgentToolEvents>();
  private connection?: ConnectionHandle;
  private readonly wsFactory?: ConnectionOptions['wsFactory'];

  constructor(resolved: ReturnType<typeof validateOptions>, wsFactory?: ConnectionOptions['wsFactory']) {
    this.appId = resolved.appId;
    this.endpoint = resolved.endpoint;
    this.token = resolved.token;
    this.targetId = resolved.targetId;
    this.instanceId = resolved.instanceId;
    this.includeErrorStack = resolved.includeErrorStack;
    this.wsFactory = wsFactory;
  }

  registerTool(def: ToolDefinition): void {
    this.registry.register(def);
    if (this.connection?.isReady()) {
      try {
        this.connection.send({
          type: 'tools/register',
          tools: [
            {
              name: def.name,
              description: def.description ?? '',
              inputSchema: this.registry.get(def.name)!.jsonSchema,
            },
          ],
        });
      } catch (err) {
        this.emitter.emit('error', { error: err as Error });
      }
    }
  }

  unregisterTool(name: string): void {
    const removed = this.registry.unregister(name);
    if (removed && this.connection?.isReady()) {
      try {
        this.connection.send({ type: 'tools/unregister', names: [name] });
      } catch (err) {
        this.emitter.emit('error', { error: err as Error });
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connection) return; // idempotent
    this.connection = createConnection({
      endpoint: this.endpoint,
      appId: this.appId,
      instanceId: this.instanceId,
      targetId: this.targetId,
      token: this.token,
      wsFactory: this.wsFactory,
      onReady: () => {
        this.emitter.emit('connected', {});
        // Flush current tool set after (re)connect.
        const snapshot = this.registry.snapshot();
        if (snapshot.length > 0) {
          try {
            this.connection?.send({ type: 'tools/register', tools: snapshot });
          } catch (err) {
            this.emitter.emit('error', { error: err as Error });
          }
        }
      },
      onClosed: (reason) => {
        this.emitter.emit('disconnected', { reason });
      },
      onError: (err) => {
        this.emitter.emit('error', { error: err });
      },
      onMessage: (msg) => this.handleMessage(msg),
    });
    try {
      await this.connection.start();
    } catch (err) {
      // Handshake-level fatal errors (auth / version); caller rejects.
      this.connection = undefined;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connection) return;
    const c = this.connection;
    this.connection = undefined;
    await c.stop();
  }

  on<K extends keyof AgentToolEvents>(
    event: K,
    handler: (payload: AgentToolEvents[K]) => void
  ): void {
    this.emitter.on(event, handler);
  }

  off<K extends keyof AgentToolEvents>(
    event: K,
    handler: (payload: AgentToolEvents[K]) => void
  ): void {
    this.emitter.off(event, handler);
  }

  private handleMessage(msg: Message): void {
    if (msg.type !== 'tool/call') return;
    void this.dispatchToolCall(msg);
  }

  private async dispatchToolCall(msg: ToolCallMessage): Promise<void> {
    const { id, name, arguments: args } = msg;
    const startedAt = Date.now();
    this.emitter.emit('toolCallStart', { name, requestId: id });

    const tool = this.registry.get(name);
    if (!tool) {
      this.reply({
        type: 'tool/result',
        id,
        ok: false,
        error: buildErrorPayload('UNKNOWN_TOOL', `unknown tool: ${name}`),
      });
      this.emitter.emit('toolCallEnd', {
        name,
        requestId: id,
        ok: false,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const parsed = tool.zodSchema.safeParse(args ?? {});
    if (!parsed.success) {
      this.reply({
        type: 'tool/result',
        id,
        ok: false,
        error: buildErrorPayload(
          'INVALID_ARGUMENT',
          parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')
        ),
      });
      this.emitter.emit('toolCallEnd', {
        name,
        requestId: id,
        ok: false,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    try {
      const data = await this.runWithTimeout(
        Promise.resolve(tool.handler(parsed.data)),
        HANDLER_TIMEOUT_MS
      );
      this.reply({ type: 'tool/result', id, ok: true, data });
      this.emitter.emit('toolCallEnd', {
        name,
        requestId: id,
        ok: true,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      const e = err as Error;
      const payload = {
        code: 'HANDLER_ERROR' as const,
        message: e.message ?? String(e),
        name: e.name,
        ...(this.includeErrorStack && e.stack ? { stack: e.stack } : {}),
      };
      this.reply({ type: 'tool/result', id, ok: false, error: payload });
      this.emitter.emit('toolCallEnd', {
        name,
        requestId: id,
        ok: false,
        latencyMs: Date.now() - startedAt,
      });
    }
  }

  private runWithTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`handler timeout after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private reply(msg: Message): void {
    if (!this.connection?.isReady()) return;
    try {
      this.connection.send(msg);
    } catch (err) {
      this.emitter.emit('error', { error: err as Error });
    }
  }
}

export { AgentToolImpl };
