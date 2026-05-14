import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { SessionRegistry, type SessionHandle } from '../src/registry.js';
import { SOFT_OFFLINE_MS } from 'web-mcp-shared';

function makeHandle(appId: string, instanceId: string): SessionHandle {
  return {
    appId,
    instanceId,
    sessionId: `${appId}:${instanceId}`,
    send: () => {},
    close: () => {},
  };
}

describe('SessionRegistry', () => {
  it('exposes registered tools with the `<appId>__` prefix', () => {
    const reg = new SessionRegistry(createLogger('error'));
    const a = makeHandle('lowcode', 'tab-1');
    reg.addSession(a);
    reg.registerTools('lowcode', 'tab-1', [
      {
        name: 'updateComponent',
        description: 'update',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    const tools = reg.listVisibleTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.fqName).toBe('lowcode__updateComponent');
  });

  it('gives the newest instance precedence on collision', () => {
    const reg = new SessionRegistry(createLogger('error'));
    const older = makeHandle('lowcode', 'tab-1');
    const newer = makeHandle('lowcode', 'tab-2');
    reg.addSession(older);
    reg.registerTools('lowcode', 'tab-1', [
      { name: 't', description: 'old', inputSchema: { type: 'object' } },
    ]);
    reg.addSession(newer);
    reg.registerTools('lowcode', 'tab-2', [
      { name: 't', description: 'new', inputSchema: { type: 'object' } },
    ]);

    const visible = reg.listVisibleTools();
    expect(visible).toHaveLength(1);
    expect(visible[0]?.description).toBe('new');

    const resolved = reg.resolveSessionForFqName('lowcode__t');
    expect(resolved?.handle.instanceId).toBe('tab-2');
  });

  it('evicts session after the soft-offline window', async () => {
    vi.useFakeTimers();
    try {
      const reg = new SessionRegistry(createLogger('error'));
      reg.addSession(makeHandle('lowcode', 'tab-1'));
      reg.registerTools('lowcode', 'tab-1', [
        { name: 't', description: 'x', inputSchema: { type: 'object' } },
      ]);
      reg.markDisconnected('lowcode', 'tab-1');
      expect(reg.listVisibleTools()).toHaveLength(1);
      vi.advanceTimersByTime(SOFT_OFFLINE_MS + 1);
      expect(reg.listVisibleTools()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
