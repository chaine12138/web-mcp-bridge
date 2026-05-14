import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { CallRouter } from '../src/router.js';
import type { SessionHandle } from '../src/registry.js';

function makeHandle(send: (msg: string) => void): SessionHandle {
  return {
    appId: 'app',
    instanceId: 'inst',
    sessionId: 'sid',
    send,
    close: () => {},
  };
}

describe('CallRouter', () => {
  it('resolves with OK when tool/result arrives before timeout', async () => {
    const router = new CallRouter(createLogger('error'));
    let captured = '';
    const handle = makeHandle((raw) => {
      captured = raw;
    });
    const pending = router.call(handle, 'app__t', 't', { a: 1 }, 1_000);
    const parsed = JSON.parse(captured) as { id: string; type: string };
    expect(parsed.type).toBe('tool/call');
    router.settle(parsed.id, { ok: true, data: { value: 42 } });
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data).toEqual({ value: 42 });
  });

  it('times out with TIMEOUT error when host never replies', async () => {
    vi.useFakeTimers();
    try {
      const router = new CallRouter(createLogger('error'));
      const handle = makeHandle(() => {});
      const pending = router.call(handle, 'app__t', 't', {}, 500);
      vi.advanceTimersByTime(501);
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops late tool/result silently after timeout', async () => {
    vi.useFakeTimers();
    try {
      const router = new CallRouter(createLogger('error'));
      let captured = '';
      const handle = makeHandle((raw) => {
        captured = raw;
      });
      const pending = router.call(handle, 'app__t', 't', {}, 500);
      vi.advanceTimersByTime(501);
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      const id = (JSON.parse(captured) as { id: string }).id;
      // Late settle must not throw and must not keep the pending entry around.
      router.settle(id, { ok: true, data: 'late' });
      expect(router.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast with TOOL_UNAVAILABLE if send throws', async () => {
    const router = new CallRouter(createLogger('error'));
    const handle = makeHandle(() => {
      throw new Error('socket dead');
    });
    const outcome = await router.call(handle, 'app__t', 't', {}, 1_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('TOOL_UNAVAILABLE');
  });
});
