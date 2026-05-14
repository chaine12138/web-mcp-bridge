import {
  HEARTBEAT_INTERVAL_MS,
  PEER_SILENCE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseMessage,
  serializeMessage,
  type Message,
  type ToolDescriptor,
} from 'web-mcp-shared';
import { AuthFailedError, VersionMismatchError } from './errors.js';

/**
 * WebSocket connection + handshake + heartbeat + exponential-backoff reconnect.
 * This layer is intentionally free of any tool-dispatch logic; callers receive
 * typed messages through `onMessage`.
 */

type WebSocketLike = WebSocket;

export interface ConnectionOptions {
  endpoint: string;
  appId: string;
  instanceId: string;
  targetId?: string;
  token: string;
  /** Called once per successfully parsed inbound message. */
  onMessage: (msg: Message) => void;
  /** Called after each successful handshake so the owner can re-send tool list. */
  onReady: () => void;
  /** Called whenever the connection transitions to "not connected". */
  onClosed: (reason: 'manual' | 'transport' | 'auth' | 'version' | 'silence') => void;
  /** Non-fatal errors surfaced to the host. */
  onError: (err: Error) => void;
  /** Inject a WS constructor for tests; defaults to global WebSocket. */
  wsFactory?: (url: string) => WebSocketLike;
}

export interface ConnectionHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: Message): void;
  isReady(): boolean;
}

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export function createConnection(opts: ConnectionOptions): ConnectionHandle {
  let ws: WebSocketLike | undefined;
  let ready = false;
  let manualStop = false;
  let backoffMs = RECONNECT_INITIAL_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let firstConnectResolve: (() => void) | undefined;
  let firstConnectReject: ((err: Error) => void) | undefined;

  const wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = undefined;
    }
  }

  function resetSilenceTimer(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      opts.onClosed('silence');
    }, PEER_SILENCE_TIMEOUT_MS);
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      try {
        ws?.send(serializeMessage({ type: 'ping' }));
      } catch (err) {
        opts.onError(new Error(`heartbeat send failed: ${(err as Error).message}`));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleReconnect(): void {
    if (manualStop) return;
    if (reconnectTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
  }

  function openSocket(): void {
    ready = false;
    try {
      ws = wsFactory(opts.endpoint);
    } catch (err) {
      opts.onError(err as Error);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      try {
        const helloMsg: any = {
          type: 'hello',
          appId: opts.appId,
          instanceId: opts.instanceId,
          token: opts.token,
          protocolVersion: PROTOCOL_VERSION,
        };
        // Include targetId if provided
        if (opts.targetId) {
          helloMsg.targetId = opts.targetId;
        }
        ws?.send(serializeMessage(helloMsg));
      } catch (err) {
        opts.onError(err as Error);
      }
      resetSilenceTimer();
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: Message;
      try {
        msg = parseMessage(ev.data);
      } catch (err) {
        opts.onError(err as Error);
        return;
      }
      resetSilenceTimer();

      if (!ready) {
        if (msg.type === 'hello_ack') {
          ready = true;
          backoffMs = RECONNECT_INITIAL_MS;
          startHeartbeat();
          opts.onReady();
          firstConnectResolve?.();
          firstConnectResolve = undefined;
          firstConnectReject = undefined;
          return;
        }
        if (msg.type === 'error') {
          const err =
            msg.code === 'AUTH_FAILED'
              ? new AuthFailedError(msg.message ?? 'auth failed')
              : msg.code === 'VERSION_MISMATCH'
                ? new VersionMismatchError(msg.message ?? 'version mismatch')
                : new Error(`${msg.code}: ${msg.message ?? ''}`);
          manualStop = msg.code === 'AUTH_FAILED' || msg.code === 'VERSION_MISMATCH';
          firstConnectReject?.(err);
          firstConnectReject = undefined;
          firstConnectResolve = undefined;
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
          opts.onClosed(msg.code === 'AUTH_FAILED' ? 'auth' : 'version');
          return;
        }
        return;
      }

      // Ping from bridge: auto pong.
      if (msg.type === 'ping') {
        try {
          ws?.send(serializeMessage({ type: 'pong' }));
        } catch {
          /* ignore */
        }
        return;
      }

      opts.onMessage(msg);
    });

    ws.addEventListener('close', () => {
      clearTimers();
      const wasReady = ready;
      ready = false;
      if (manualStop) {
        opts.onClosed('manual');
        return;
      }
      opts.onClosed(wasReady ? 'transport' : 'transport');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Let `close` drive the lifecycle; `error` alone is mostly an advisory.
      opts.onError(new Error('websocket error'));
    });
  }

  return {
    start() {
      return new Promise<void>((resolve, reject) => {
        firstConnectResolve = resolve;
        firstConnectReject = reject;
        manualStop = false;
        openSocket();
      });
    },
    async stop() {
      manualStop = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      clearTimers();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ready = false;
    },
    send(msg: Message) {
      if (!ready || !ws) throw new Error('connection not ready');
      ws.send(serializeMessage(msg));
    },
    isReady() {
      return ready;
    },
  };
}

export type { Message, ToolDescriptor };
