import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  InvalidMessageError,
  PROTOCOL_VERSION,
  isErrorCode,
  parseMessage,
  serializeMessage,
} from './index.js';

describe('protocol parsing', () => {
  it('accepts a well-formed hello', () => {
    const msg = parseMessage(
      JSON.stringify({
        type: 'hello',
        appId: 'a',
        instanceId: 'i',
        token: 't',
        protocolVersion: PROTOCOL_VERSION,
      })
    );
    if (msg.type !== 'hello') throw new Error('wrong type');
    expect(msg.appId).toBe('a');
  });

  it('accepts hello with optional targetId', () => {
    const msg = parseMessage(
      JSON.stringify({
        type: 'hello',
        appId: 'a',
        instanceId: 'i',
        targetId: 'order-123',
        token: 't',
        protocolVersion: PROTOCOL_VERSION,
      })
    );
    if (msg.type !== 'hello') throw new Error('wrong type');
    expect(msg.targetId).toBe('order-123');
  });

  it('accepts hello without targetId (backward compatible)', () => {
    const msg = parseMessage(
      JSON.stringify({
        type: 'hello',
        appId: 'a',
        instanceId: 'i',
        token: 't',
        protocolVersion: PROTOCOL_VERSION,
      })
    );
    if (msg.type !== 'hello') throw new Error('wrong type');
    expect(msg.targetId).toBeUndefined();
  });

  it('accepts tool/call with optional _meta', () => {
    const msg = parseMessage(
      JSON.stringify({
        type: 'tool/call',
        id: 'req-1',
        name: 'testTool',
        arguments: { foo: 'bar' },
        _meta: { targetId: 'order-456' },
      })
    );
    if (msg.type !== 'tool/call') throw new Error('wrong type');
    expect(msg._meta?.targetId).toBe('order-456');
  });

  it('accepts tool/call without _meta (backward compatible)', () => {
    const msg = parseMessage(
      JSON.stringify({
        type: 'tool/call',
        id: 'req-2',
        name: 'testTool',
        arguments: {},
      })
    );
    if (msg.type !== 'tool/call') throw new Error('wrong type');
    expect(msg._meta).toBeUndefined();
  });

  it('accepts a tool/result success and failure', () => {
    const ok = parseMessage(
      JSON.stringify({ type: 'tool/result', id: '1', ok: true, data: { x: 1 } })
    );
    const fail = parseMessage(
      JSON.stringify({
        type: 'tool/result',
        id: '2',
        ok: false,
        error: { code: 'HANDLER_ERROR', message: 'boom' },
      })
    );
    expect(ok.type).toBe('tool/result');
    expect(fail.type).toBe('tool/result');
  });

  it('rejects unknown message type', () => {
    expect(() =>
      parseMessage(JSON.stringify({ type: 'foobar' }))
    ).toThrowError(InvalidMessageError);
  });

  it('rejects bad JSON', () => {
    expect(() => parseMessage('{not-json')).toThrowError(InvalidMessageError);
  });

  it('rejects error payload with out-of-enum code', () => {
    expect(() =>
      parseMessage(
        JSON.stringify({
          type: 'tool/result',
          id: '3',
          ok: false,
          error: { code: 'NOPE', message: 'x' },
        })
      )
    ).toThrowError(InvalidMessageError);
  });

  it('round-trips via serializeMessage', () => {
    const src = { type: 'ping' } as const;
    const out = parseMessage(serializeMessage(src));
    expect(out.type).toBe('ping');
  });
});

describe('error code enum', () => {
  it('is frozen to the exact v1 set', () => {
    expect(ERROR_CODES).toEqual([
      'AUTH_FAILED',
      'VERSION_MISMATCH',
      'INVALID_MESSAGE',
      'INVALID_ARGUMENT',
      'UNKNOWN_TOOL',
      'HANDLER_ERROR',
      'TOOL_UNAVAILABLE',
      'TIMEOUT',
    ]);
  });

  it('isErrorCode narrows correctly', () => {
    expect(isErrorCode('AUTH_FAILED')).toBe(true);
    expect(isErrorCode('NOPE')).toBe(false);
    expect(isErrorCode(123)).toBe(false);
  });
});
