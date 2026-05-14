import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  TOOL_CALL_TIMEOUT_MS,
  buildErrorPayload,
  serializeMessage,
  type ErrorPayload,
} from '@web-mcp/shared';
import type { SessionHandle } from './registry.js';
import type { Logger } from './logger.js';

/**
 * Tracks in-flight Agent→Host tool calls. Each call has a unique requestId and a
 * hard deadline; late results after timeout are silently dropped.
 */

export interface CallOk {
  ok: true;
  data: unknown;
}

export interface CallFail {
  ok: false;
  error: ErrorPayload;
}

export type CallOutcome = CallOk | CallFail;

interface PendingCall {
  handle: SessionHandle;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (outcome: CallOutcome) => void;
  fqName: string;
  toolName: string;
}

export class CallRouter {
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly logger: Logger) {}

  call(
    handle: SessionHandle,
    fqName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = TOOL_CALL_TIMEOUT_MS
  ): Promise<CallOutcome> {
    const requestId = randomUUID();
    return new Promise<CallOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        this.logger.warn('tool_call_timeout', {
          appId: handle.appId,
          instanceId: handle.instanceId,
          toolName,
          requestId,
          latencyMs: Date.now() - entry.startedAt,
        });
        resolve({
          ok: false,
          error: buildErrorPayload('TIMEOUT', `tool call timed out after ${timeoutMs}ms`),
        });
      }, timeoutMs);

      this.pending.set(requestId, {
        handle,
        startedAt: Date.now(),
        timer,
        resolve,
        fqName,
        toolName,
      });

      try {
        handle.send(
          serializeMessage({
            type: 'tool/call',
            id: requestId,
            name: toolName,
            arguments: args,
          })
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({
          ok: false,
          error: buildErrorPayload(
            'TOOL_UNAVAILABLE',
            `failed to deliver tool/call: ${(err as Error).message}`
          ),
        });
      }
    });
  }

  /** Feed a tool/result received from a host session. */
  settle(requestId: string, outcome: CallOutcome): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      this.logger.debug('tool_result_dropped_late', { requestId });
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.logger.info(outcome.ok ? 'tool_call_ok' : 'tool_call_err', {
      appId: entry.handle.appId,
      instanceId: entry.handle.instanceId,
      toolName: entry.toolName,
      requestId,
      latencyMs: Date.now() - entry.startedAt,
      ...(outcome.ok ? {} : { errorCode: outcome.error.code }),
    });
    entry.resolve(outcome);
  }

  /**
   * Invalidate every in-flight call attached to a given session; called when
   * the session is evicted (hard drop or soft-offline timeout).
   */
  cancelForSession(handle: SessionHandle, code: ErrorCode, message: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.handle !== handle) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ ok: false, error: buildErrorPayload(code, message) });
    }
  }

  /** Invalidate every in-flight call during shutdown. */
  cancelAll(code: ErrorCode, message: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ ok: false, error: buildErrorPayload(code, message) });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
