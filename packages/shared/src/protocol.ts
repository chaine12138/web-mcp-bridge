import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

/**
 * Wire messages exchanged between @web-mcp/bridge (Node) and @web-mcp/sdk (browser)
 * over a single WebSocket. Each payload is a JSON object with a discriminant `type`.
 */

export const MESSAGE_TYPES = [
  'hello',
  'hello_ack',
  'tools/register',
  'tools/unregister',
  'tool/call',
  'tool/result',
  'ping',
  'pong',
  'error',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Standalone JSON Schema object; we do not re-validate it here, bridge forwards as-is. */
const JsonSchemaLike = z.record(z.any());

const ToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  inputSchema: JsonSchemaLike,
});

export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

const ErrorPayloadSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
});

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  appId: z.string().min(1),
  instanceId: z.string().min(1),
  targetId: z.string().optional(),
  token: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});

export const HelloAckMessageSchema = z.object({
  type: z.literal('hello_ack'),
  sessionId: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});

export const ToolsRegisterMessageSchema = z.object({
  type: z.literal('tools/register'),
  tools: z.array(ToolDescriptorSchema).min(1),
});

export const ToolsUnregisterMessageSchema = z.object({
  type: z.literal('tools/unregister'),
  names: z.array(z.string().min(1)).min(1),
});

export const ToolCallMessageSchema = z.object({
  type: z.literal('tool/call'),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.any()).optional().default({}),
  _meta: z.object({
    targetId: z.string().optional(),
  }).optional(),
});

export const ToolResultMessageSchema = z.union([
  z.object({
    type: z.literal('tool/result'),
    id: z.string().min(1),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('tool/result'),
    id: z.string().min(1),
    ok: z.literal(false),
    error: ErrorPayloadSchema,
  }),
]);

export const PingMessageSchema = z.object({ type: z.literal('ping') });
export const PongMessageSchema = z.object({ type: z.literal('pong') });

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.enum(ERROR_CODES),
  message: z.string().optional(),
});

/** Discriminated union of every legal wire message. */
export const MessageSchema = z.union([
  HelloMessageSchema,
  HelloAckMessageSchema,
  ToolsRegisterMessageSchema,
  ToolsUnregisterMessageSchema,
  ToolCallMessageSchema,
  ToolResultMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  ErrorMessageSchema,
]);

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type HelloAckMessage = z.infer<typeof HelloAckMessageSchema>;
export type ToolsRegisterMessage = z.infer<typeof ToolsRegisterMessageSchema>;
export type ToolsUnregisterMessage = z.infer<typeof ToolsUnregisterMessageSchema>;
export type ToolCallMessage = z.infer<typeof ToolCallMessageSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;

export class InvalidMessageError extends Error {
  override readonly name = 'InvalidMessageError';
}

/** Parse a raw WS frame (string | Buffer-ish) into a typed Message or throw. */
export function parseMessage(raw: unknown): Message {
  let payload: unknown;
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder('utf-8').decode(raw)
          : String(raw);
    payload = JSON.parse(text);
  } catch (err) {
    throw new InvalidMessageError(
      `Failed to parse JSON: ${(err as Error).message}`
    );
  }
  const result = MessageSchema.safeParse(payload);
  if (!result.success) {
    throw new InvalidMessageError(
      `Message does not match protocol: ${result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`
    );
  }
  return result.data;
}

/** Convenience serializer to keep JSON.stringify sites consistent. */
export function serializeMessage(msg: Message): string {
  return JSON.stringify(msg);
}
