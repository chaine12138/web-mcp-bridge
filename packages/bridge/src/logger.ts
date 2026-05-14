/**
 * Structured JSON logger. Writes to stderr to keep stdout reserved for MCP stdio transport.
 * Never logs the bridge token or raw tool arguments by default.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  appId?: string;
  instanceId?: string;
  toolName?: string;
  requestId?: string;
  latencyMs?: number;
  [k: string]: unknown;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (
    lvl: LogLevel,
    base: LogFields,
    event: string,
    fields?: LogFields
  ): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      event,
      ...base,
      ...fields,
    });
    // stderr: leave stdout free for MCP stdio transport.
    process.stderr.write(line + '\n');
  };

  const make = (base: LogFields): Logger => ({
    debug: (event, fields) => emit('debug', base, event, fields),
    info: (event, fields) => emit('info', base, event, fields),
    warn: (event, fields) => emit('warn', base, event, fields),
    error: (event, fields) => emit('error', base, event, fields),
    child: (fields) => make({ ...base, ...fields }),
  });

  return make({});
}
