import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDescriptor } from '@web-mcp/shared';
import { DuplicateToolError, InvalidAgentToolOptionsError } from './errors.js';

/**
 * Host-facing tool definition. `inputSchema` MUST be a Zod schema; the SDK
 * converts it to JSON Schema before sending to the bridge.
 */
export interface ToolDefinition<
  Schema extends ZodTypeAny = ZodTypeAny,
  Result = unknown,
> {
  name: string;
  description?: string;
  inputSchema: Schema;
  handler: (input: unknown) => Result | Promise<Result>;
}

interface StoredTool {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  zodSchema: ZodTypeAny;
  handler: (input: unknown) => unknown | Promise<unknown>;
}

/**
 * Local table of tools a host has registered on this page. Responsible for
 * producing the wire-level descriptors + running handlers on incoming calls.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, StoredTool>();

  register(def: ToolDefinition): void {
    if (!def || typeof def.name !== 'string' || def.name.length === 0) {
      throw new InvalidAgentToolOptionsError('tool.name must be a non-empty string');
    }
    if (typeof def.handler !== 'function') {
      throw new InvalidAgentToolOptionsError('tool.handler must be a function');
    }
    if (!def.inputSchema || typeof (def.inputSchema as ZodTypeAny).safeParse !== 'function') {
      throw new InvalidAgentToolOptionsError('tool.inputSchema must be a Zod schema');
    }
    if (this.tools.has(def.name)) {
      throw new DuplicateToolError(def.name);
    }
    const jsonSchema = zodToJsonSchema(def.inputSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;

    // Inject _bridge_meta property so MCP clients don't strip it during
    // argument validation. The bridge extracts and removes this before
    // dispatching to the handler.
    injectBridgeMetaSchema(jsonSchema);
    this.tools.set(def.name, {
      name: def.name,
      description: def.description ?? '',
      jsonSchema,
      zodSchema: def.inputSchema as ZodTypeAny,
      handler: def.handler as (input: unknown) => unknown | Promise<unknown>,
    });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): StoredTool | undefined {
    return this.tools.get(name);
  }

  snapshot(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
    }));
  }

  size(): number {
    return this.tools.size;
  }
}

// --- Internal helpers ------------------------------------------------------

/**
 * Mutate a zod-to-json-schema output to declare `_bridge_meta` as a legal
 * property. MCP clients validate `arguments` against this schema before
 * sending; without this, `additionalProperties: false` strips `_bridge_meta`.
 */
function injectBridgeMetaSchema(schema: Record<string, unknown>): void {
  if (!schema || typeof schema !== 'object') return;

  // Ensure properties exists and is an object.
  if (!('properties' in schema) || typeof schema.properties !== 'object' || schema.properties === null) {
    schema.properties = {};
  }

  // Add _bridge_meta definition.
  (schema.properties as Record<string, unknown>)._bridge_meta = {
    type: 'object',
    description: 'Bridge routing metadata. Do NOT use for business arguments.',
    properties: {
      targetId: {
        type: 'string',
        description: 'Target session/window ID for multi-instance routing.',
      },
    },
    additionalProperties: false,
  };

  // If additionalProperties was explicitly false, keep it; _bridge_meta is now
  // an explicit property so it will pass validation.
  // No need to modify additionalProperties here.
}
