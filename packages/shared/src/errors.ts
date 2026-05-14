/** Frozen v1 error code enum. Any other value must be treated as INVALID_MESSAGE. */
export const ERROR_CODES = [
  'AUTH_FAILED',
  'VERSION_MISMATCH',
  'INVALID_MESSAGE',
  'INVALID_ARGUMENT',
  'UNKNOWN_TOOL',
  'HANDLER_ERROR',
  'TOOL_UNAVAILABLE',
  'TIMEOUT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  name?: string;
  stack?: string;
}

export function buildErrorPayload(
  code: ErrorCode,
  message: string,
  extra?: { name?: string; stack?: string }
): ErrorPayload {
  const payload: ErrorPayload = { code, message };
  if (extra?.name) payload.name = extra.name;
  if (extra?.stack) payload.stack = extra.stack;
  return payload;
}
