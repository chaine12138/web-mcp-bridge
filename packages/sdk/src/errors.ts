/**
 * Public error classes surfaced by `@web-mcp/sdk`.
 * Each subclass sets a stable `name` so hosts can branch on `err.name` instead
 * of relying on `instanceof` (which breaks across module duplication).
 */

export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentToolError';
  }
}

export class AgentToolAlreadyInitializedError extends AgentToolError {
  constructor(message = 'createAgentTool has already been called in this runtime') {
    super(message);
    this.name = 'AgentToolAlreadyInitializedError';
  }
}

export class InvalidAgentToolOptionsError extends AgentToolError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentToolOptionsError';
  }
}

export class DuplicateToolError extends AgentToolError {
  constructor(name: string) {
    super(`tool "${name}" is already registered`);
    this.name = 'DuplicateToolError';
  }
}

export class AuthFailedError extends AgentToolError {
  constructor(message = 'authentication failed') {
    super(message);
    this.name = 'AuthFailedError';
  }
}

export class VersionMismatchError extends AgentToolError {
  constructor(message = 'protocol version mismatch') {
    super(message);
    this.name = 'VersionMismatchError';
  }
}
