#!/usr/bin/env node
/**
 * CLI entry for web-mcp-bridge.
 *
 * Usage:
 *   web-mcp-bridge --token <secret> [--port 7321] [--host 127.0.0.1] [--log-level info]
 *
 * The bridge:
 *   1. Boots a local WebSocket server (127.0.0.1 only) for browser SDKs.
 *   2. Boots an MCP stdio server that aggregates tools registered by connected hosts.
 *   3. Keeps stdout exclusively for MCP stdio transport; logs go to stderr as JSON.
 */

import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
} from 'web-mcp-shared';
import { createLogger, type LogLevel } from './logger.js';
import { McpBridgeServer } from './mcp-server.js';
import { SessionRegistry } from './registry.js';
import { CallRouter } from './router.js';
import { WsServer } from './ws-server.js';

interface CliOptions {
  port: number;
  host: string;
  token: string;
  logLevel: LogLevel;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseArgs(argv: string[]): CliOptions {
  let port = DEFAULT_BRIDGE_PORT as number;
  let host = DEFAULT_BRIDGE_HOST as string;
  let token = process.env.WEB_MCP_TOKEN ?? '';
  let logLevel: LogLevel = 'info';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      i++;
      return v;
    };
    switch (arg) {
      case '--port': {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0 || n > 65_535) {
          throw new Error(`invalid --port: ${n}`);
        }
        port = n;
        break;
      }
      case '--host':
        host = next();
        break;
      case '--token':
        token = next();
        break;
      case '--log-level': {
        const v = next() as LogLevel;
        if (!LOG_LEVELS.includes(v)) {
          throw new Error(`invalid --log-level: ${v}`);
        }
        logLevel = v;
        break;
      }
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      case '--version':
      case '-v':
        // package.json version; kept in sync manually.
        process.stdout.write('0.1.0\n');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!token) {
    throw new Error(
      'missing token: provide --token <secret> or set WEB_MCP_TOKEN env var'
    );
  }

  return { port, host, token, logLevel };
}

function printHelp(): void {
  process.stdout.write(
    [
      'web-mcp-bridge — Local MCP bridge forwarding to in-browser host apps over WebSocket.',
      '',
      'Usage:',
      '  web-mcp-bridge --token <secret> [--port 7321] [--host 127.0.0.1] [--log-level info]',
      '',
      'Flags:',
      '  --token        Shared secret for SDK↔bridge WS handshake (or env WEB_MCP_TOKEN).',
      '  --port         TCP port (default 7321).',
      '  --host         Bind host (default 127.0.0.1, localhost only).',
      '  --log-level    debug | info | warn | error (default info).',
      '  --help, -h     Print this help.',
      '  --version, -v  Print version.',
      '',
    ].join('\n')
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(2);
    return;
  }

  const startedAt = Date.now();
  const logger = createLogger(opts.logLevel);
  const registry = new SessionRegistry(logger);
  const router = new CallRouter(logger);
  const wsServer = new WsServer({
    port: opts.port,
    host: opts.host,
    token: opts.token,
    registry,
    router,
    logger,
  });
  const mcpServer = new McpBridgeServer({ registry, router, logger, startedAt });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown_begin', { signal });
    router.cancelAll('TOOL_UNAVAILABLE', 'bridge shutting down');
    try {
      await wsServer.stop();
    } catch (err) {
      logger.warn('ws_stop_failed', { message: (err as Error).message });
    }
    try {
      await mcpServer.stop();
    } catch (err) {
      logger.warn('mcp_stop_failed', { message: (err as Error).message });
    }
    logger.info('shutdown_done');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await wsServer.start();
    await mcpServer.start();
    logger.info('bridge_ready', { port: opts.port, host: opts.host });
  } catch (err) {
    logger.error('bridge_start_failed', { message: (err as Error).message });
    process.exit(1);
  }
}

// Run when invoked directly via node or shebang.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  /cli\.(js|ts)$/.test(process.argv[1]);

if (invokedDirectly) {
  void main();
}
