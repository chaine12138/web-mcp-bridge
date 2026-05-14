import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  HELLO_TIMEOUT_MS,
  PEER_SILENCE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  buildErrorPayload,
  isErrorCode,
  parseMessage,
  serializeMessage,
  type ErrorCode,
  type Message,
} from 'web-mcp-shared';
import type { Logger } from './logger.js';
import type { SessionHandle, SessionRegistry } from './registry.js';
import type { CallRouter } from './router.js';

/**
 * WebSocket server bound to 127.0.0.1. Handles handshake (+ token auth), heartbeats,
 * fans tool registrations into the SessionRegistry, and fans tool results back into
 * the CallRouter.
 */

export interface WsServerOptions {
  port?: number;
  host?: string;
  token: string;
  registry: SessionRegistry;
  router: CallRouter;
  logger: Logger;
}

interface SocketState {
  handshook: boolean;
  appId?: string;
  instanceId?: string;
  targetId?: string;
  handle?: SessionHandle;
  helloTimer?: NodeJS.Timeout;
  silenceTimer?: NodeJS.Timeout;
}

export class WsServer {
  private wss?: WebSocketServer;
  private readonly states = new WeakMap<WebSocket, SocketState>();

  constructor(private readonly opts: WsServerOptions) {}

  async start(): Promise<{ port: number; host: string }> {
    const host = this.opts.host ?? DEFAULT_BRIDGE_HOST;
    const port = this.opts.port ?? DEFAULT_BRIDGE_PORT;
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host, port });
      this.wss = wss;
      wss.once('listening', () => {
        const addr = wss.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        this.opts.logger.info('listening', { host, port: actualPort });
        resolve({ host, port: actualPort });
      });
      wss.once('error', reject);
      wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remotePort ?? -1));
    });
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    await new Promise<void>((r) => wss.close(() => r()));
    this.wss = undefined;
  }

  private onConnection(ws: WebSocket, remotePort: number): void {
    const state: SocketState = { handshook: false };
    this.states.set(ws, state);

    // Hello timeout: if no hello arrives in HELLO_TIMEOUT_MS, close.
    state.helloTimer = setTimeout(() => {
      if (!state.handshook) {
        this.opts.logger.warn('hello_timeout', { remotePort });
        this.closeWithError(ws, 'INVALID_MESSAGE', 'handshake timeout');
      }
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', (err) => {
      this.opts.logger.warn('ws_error', { message: err.message, remotePort });
    });

    this.resetSilenceTimer(ws, state);
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    const state = this.states.get(ws);
    if (!state) return;
    this.resetSilenceTimer(ws, state);

    let msg: Message;
    try {
      msg = parseMessage(data);
    } catch (err) {
      this.opts.logger.warn('invalid_message', { message: (err as Error).message });
      this.closeWithError(ws, 'INVALID_MESSAGE', 'invalid message');
      return;
    }

    if (!state.handshook) {
      if (msg.type !== 'hello') {
        this.closeWithError(ws, 'INVALID_MESSAGE', 'expected hello first');
        return;
      }
      this.handleHello(ws, state, msg);
      return;
    }

    switch (msg.type) {
      case 'ping':
        ws.send(serializeMessage({ type: 'pong' }));
        return;
      case 'pong':
        return; // already reset silence timer
      case 'tools/register':
        if (state.appId && state.instanceId) {
          this.opts.registry.registerTools(state.appId, state.instanceId, msg.tools);
        }
        return;
      case 'tools/unregister':
        if (state.appId && state.instanceId) {
          this.opts.registry.unregisterTools(state.appId, state.instanceId, msg.names);
        }
        return;
      case 'tool/result':
        if (msg.ok) {
          this.opts.router.settle(msg.id, { ok: true, data: msg.data });
        } else {
          this.opts.router.settle(msg.id, { ok: false, error: msg.error });
        }
        return;
      case 'hello':
      case 'hello_ack':
      case 'tool/call':
      case 'error':
        // Unexpected direction; just log and continue.
        this.opts.logger.debug('unexpected_message_direction', { type: msg.type });
        return;
    }
  }

  private handleHello(
    ws: WebSocket,
    state: SocketState,
    msg: Extract<Message, { type: 'hello' }>
  ): void {
    if (state.helloTimer) clearTimeout(state.helloTimer);
    state.helloTimer = undefined;

    if (msg.token !== this.opts.token) {
      this.opts.logger.warn('auth_failed');
      this.closeWithError(ws, 'AUTH_FAILED', 'bad token');
      return;
    }
    if (msg.protocolVersion > PROTOCOL_VERSION) {
      this.closeWithError(ws, 'VERSION_MISMATCH', `bridge supports v${PROTOCOL_VERSION}`);
      return;
    }

    const sessionId = randomUUID();
    const handle: SessionHandle = {
      appId: msg.appId,
      instanceId: msg.instanceId,
      targetId: msg.targetId,
      sessionId,
      send: (raw) => {
        try {
          ws.send(raw);
        } catch (err) {
          throw new Error(`ws.send failed: ${(err as Error).message}`);
        }
      },
      close: () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
    state.handshook = true;
    state.appId = msg.appId;
    state.instanceId = msg.instanceId;
    state.handle = handle;
    this.opts.registry.addSession(handle);

    ws.send(
      serializeMessage({
        type: 'hello_ack',
        sessionId,
        protocolVersion: PROTOCOL_VERSION,
      })
    );
    this.opts.logger.info('session_ready', {
      appId: msg.appId,
      instanceId: msg.instanceId,
      sessionId,
    });
  }

  private onClose(ws: WebSocket): void {
    const state = this.states.get(ws);
    if (!state) return;
    if (state.helloTimer) clearTimeout(state.helloTimer);
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    if (state.handle) {
      this.opts.router.cancelForSession(state.handle, 'TOOL_UNAVAILABLE', 'session disconnected');
      this.opts.registry.markDisconnected(state.handle.appId, state.handle.instanceId);
      this.opts.logger.info('session_disconnected', {
        appId: state.handle.appId,
        instanceId: state.handle.instanceId,
      });
    }
  }

  private resetSilenceTimer(ws: WebSocket, state: SocketState): void {
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    state.silenceTimer = setTimeout(() => {
      this.opts.logger.warn('peer_silent', {
        appId: state.appId,
        instanceId: state.instanceId,
      });
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, PEER_SILENCE_TIMEOUT_MS);
  }

  private closeWithError(ws: WebSocket, code: ErrorCode, message: string): void {
    const safeCode: ErrorCode = isErrorCode(code) ? code : 'INVALID_MESSAGE';
    try {
      ws.send(serializeMessage({ type: 'error', code: safeCode, message }));
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    // keep ref so eslint no-unused-vars happy
    buildErrorPayload;
  }
}
