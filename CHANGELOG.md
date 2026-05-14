# Changelog

All notable changes to the `@web-mcp/*` packages are recorded in this file.
The project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First cut, matching OpenSpec change `init-web-mcp-bridge`.

### Added — `@web-mcp/bridge`
- Localhost-only WebSocket server (`127.0.0.1`) with token handshake, protocol-version negotiation, and 15 s/30 s heartbeat contract.
- MCP stdio server that aggregates tools from every connected host session.
- `<appId>__<toolName>` namespace exposed to the agent; resolution strips the prefix before fanning out to the host.
- `CallRouter` with 30 s per-call timeout, late-result drop, session cancellation on disconnect.
- `SessionRegistry` with 2 s soft-offline window (page-reload-safe) and "newest instance wins" policy.
- Built-in `__bridge__health` tool returning live session / tool counts.
- Structured JSON logs to stderr; stdout reserved for MCP stdio.
- CLI: `web-mcp-bridge --token ... [--port 7321] [--host 127.0.0.1] [--log-level info]`.

### Added — `@web-mcp/sdk`
- `createAgentTool(options)` single-instance factory; attaches to `window.agent_tool` by default.
- `window.agent_tool.registerTool({ name, description, inputSchema, handler })` as the **only** registration entry point. No auto-scanning / reflection / OpenAPI derivation.
- Zod → JSON Schema conversion on registration.
- Automatic WS handshake, heartbeat, and exponential-backoff reconnect (500 ms → 30 s).
- `tool/call` dispatch with argument validation (`INVALID_ARGUMENT`), 60 s handler timeout, opt-in stack inclusion.
- Typed event emitter: `connected / disconnected / error / toolCallStart / toolCallEnd`.
- Public error classes with stable `name` strings for `err.name` branching.

### Added — `@web-mcp/shared`
- Protocol v1 constants, Zod schemas, `parseMessage / serializeMessage`, frozen error-code enum.

### Added — tooling
- pnpm monorepo with `packages/*` and `examples/*`.
- `examples/e2e` smoke test that boots the bridge in-process and drives it through a fake WS client.
- `docs/PROTOCOL.md` freezing the v1 wire protocol.
