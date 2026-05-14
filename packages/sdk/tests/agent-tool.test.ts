import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  __resetAgentToolForTests,
  createAgentTool,
  AgentToolAlreadyInitializedError,
  InvalidAgentToolOptionsError,
  DuplicateToolError,
  type AgentTool,
} from '../src/index.js';

/**
 * Minimal fake WebSocket that records outbound frames and lets the test
 * drive inbound frames via `pushInbound`.
 */
class FakeWebSocket {
  static OPEN = 1 as const;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  addEventListener(event: string, handler: (ev: unknown) => void): void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(handler);
  }
  removeEventListener(event: string, handler: (ev: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }
  dispatch(event: string, payload?: unknown): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const h of [...bucket]) h(payload);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.dispatch('close');
  }
  /** Convenience helpers used by the test harness. */
  openHandshakeWith(sessionId = 'sid-1'): void {
    this.dispatch('open');
    this.dispatch('message', {
      data: JSON.stringify({
        type: 'hello_ack',
        sessionId,
        protocolVersion: 1,
      }),
    });
  }
  pushInbound(msg: unknown): void {
    this.dispatch('message', { data: JSON.stringify(msg) });
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createAgentTool', () => {
  afterEach(() => {
    __resetAgentToolForTests();
  });

  it('throws InvalidAgentToolOptionsError when required fields are missing', () => {
    expect(() =>
      createAgentTool({ appId: '', endpoint: 'ws://x', token: 't' })
    ).toThrowError(InvalidAgentToolOptionsError);
    expect(() =>
      createAgentTool({ appId: 'a', endpoint: 'http://x', token: 't' })
    ).toThrowError(InvalidAgentToolOptionsError);
    expect(() =>
      createAgentTool({ appId: 'a', endpoint: 'ws://x', token: '' })
    ).toThrowError(InvalidAgentToolOptionsError);
  });

  it('attaches the instance to globalThis.agent_tool by default', () => {
    const inst = createAgentTool({
      appId: 'lowcode',
      endpoint: 'ws://127.0.0.1:7321',
      token: 'secret',
    });
    expect((globalThis as unknown as { agent_tool?: AgentTool }).agent_tool).toBe(inst);
  });

  it('refuses to initialize twice', () => {
    createAgentTool({
      appId: 'a',
      endpoint: 'ws://127.0.0.1:7321',
      token: 't',
    });
    expect(() =>
      createAgentTool({
        appId: 'b',
        endpoint: 'ws://127.0.0.1:7321',
        token: 't',
      })
    ).toThrowError(AgentToolAlreadyInitializedError);
  });
});

describe('AgentTool.registerTool', () => {
  let fakeWs: FakeWebSocket;
  let agent: AgentTool;

  beforeEach(async () => {
    fakeWs = new FakeWebSocket();
    agent = createAgentTool({
      appId: 'lowcode',
      endpoint: 'ws://127.0.0.1:7321',
      token: 'secret',
      autoAttachToWindow: false,
      wsFactory: () => fakeWs as unknown as WebSocket,
    });
  });

  afterEach(() => {
    __resetAgentToolForTests();
  });

  it('rejects duplicate tool names', () => {
    agent.registerTool({
      name: 'updateComponent',
      description: '',
      inputSchema: z.object({ id: z.string() }),
      handler: () => ({}),
    });
    expect(() =>
      agent.registerTool({
        name: 'updateComponent',
        description: '',
        inputSchema: z.object({ id: z.string() }),
        handler: () => ({}),
      })
    ).toThrowError(DuplicateToolError);
  });

  it('batches pre-connect registrations into a single tools/register after handshake', async () => {
    agent.registerTool({
      name: 'a',
      inputSchema: z.object({}),
      handler: () => 1,
    });
    agent.registerTool({
      name: 'b',
      inputSchema: z.object({}),
      handler: () => 2,
    });
    const connectP = agent.connect();
    fakeWs.openHandshakeWith();
    await connectP;
    await tick();

    const sentTypes = fakeWs.sent
      .map((s) => JSON.parse(s) as { type: string; tools?: unknown[] });
    const register = sentTypes.find((m) => m.type === 'tools/register');
    expect(register?.tools).toHaveLength(2);
  });

  it('sends an incremental tools/register when already connected', async () => {
    const connectP = agent.connect();
    fakeWs.openHandshakeWith();
    await connectP;
    await tick();
    fakeWs.sent.length = 0;

    agent.registerTool({
      name: 'later',
      inputSchema: z.object({}),
      handler: () => 'ok',
    });
    const msg = JSON.parse(fakeWs.sent.pop() ?? '{}') as {
      type: string;
      tools: Array<{ name: string }>;
    };
    expect(msg.type).toBe('tools/register');
    expect(msg.tools.map((t) => t.name)).toEqual(['later']);
  });
});

describe('AgentTool tool/call dispatch', () => {
  let fakeWs: FakeWebSocket;
  let agent: AgentTool;

  beforeEach(async () => {
    fakeWs = new FakeWebSocket();
    agent = createAgentTool({
      appId: 'lowcode',
      endpoint: 'ws://127.0.0.1:7321',
      token: 'secret',
      autoAttachToWindow: false,
      wsFactory: () => fakeWs as unknown as WebSocket,
    });
    const p = agent.connect();
    fakeWs.openHandshakeWith();
    await p;
    fakeWs.sent.length = 0;
  });

  afterEach(() => {
    __resetAgentToolForTests();
  });

  it('replies UNKNOWN_TOOL for unregistered names', async () => {
    fakeWs.pushInbound({ type: 'tool/call', id: 'r1', name: 'nope', arguments: {} });
    await tick();
    const out = JSON.parse(fakeWs.sent.pop() ?? '{}') as {
      type: string; id: string; ok: boolean; error?: { code: string };
    };
    expect(out.type).toBe('tool/result');
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('UNKNOWN_TOOL');
  });

  it('runs the handler and replies with serializable data', async () => {
    agent.registerTool({
      name: 'echo',
      inputSchema: z.object({ msg: z.string() }),
      handler: (input) => ({ echoed: (input as { msg: string }).msg.toUpperCase() }),
    });
    fakeWs.sent.length = 0;

    fakeWs.pushInbound({
      type: 'tool/call',
      id: 'r2',
      name: 'echo',
      arguments: { msg: 'hi' },
    });
    await tick();
    await tick();
    const out = JSON.parse(fakeWs.sent.pop() ?? '{}') as {
      type: string; ok: boolean; data: { echoed: string };
    };
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ echoed: 'HI' });
  });

  it('returns INVALID_ARGUMENT when arguments fail zod validation', async () => {
    agent.registerTool({
      name: 'strict',
      inputSchema: z.object({ id: z.string() }),
      handler: () => 'ok',
    });
    fakeWs.sent.length = 0;
    fakeWs.pushInbound({
      type: 'tool/call',
      id: 'r3',
      name: 'strict',
      arguments: { id: 42 },
    });
    await tick();
    const out = JSON.parse(fakeWs.sent.pop() ?? '{}') as {
      ok: boolean; error?: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('returns HANDLER_ERROR with no stack by default', async () => {
    agent.registerTool({
      name: 'boom',
      inputSchema: z.object({}),
      handler: () => {
        throw new TypeError('bad');
      },
    });
    fakeWs.sent.length = 0;
    fakeWs.pushInbound({
      type: 'tool/call',
      id: 'r4',
      name: 'boom',
      arguments: {},
    });
    await tick();
    await tick();
    const out = JSON.parse(fakeWs.sent.pop() ?? '{}') as {
      ok: boolean; error?: { code: string; name: string; stack?: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('HANDLER_ERROR');
    expect(out.error?.name).toBe('TypeError');
    expect(out.error?.stack).toBeUndefined();
  });
});
