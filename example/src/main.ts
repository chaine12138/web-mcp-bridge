/**
 * E2E smoke test without a real browser:
 *
 *   1. Boot the bridge's WsServer + CallRouter + SessionRegistry in-process.
 *   2. Connect a tiny WebSocket client that speaks the protocol directly
 *      (standing in for web-page-mcp-sdk running inside a browser).
 *   3. Register a single tool, fire a call from the router, verify the result.
 *
 * This deliberately does NOT spin up the MCP stdio server — that requires a
 * separate MCP client. The WS <-> registry <-> router path is the critical
 * contract verified here.
 *
 * Usage:  pnpm --filter @web-mcp/e2e run
 */

import {
  CallRouter,
  SessionRegistry,
  WsServer,
  createLogger,
} from 'web-page-mcp-bridge';
import {
  PROTOCOL_VERSION,
  parseMessage,
  serializeMessage,
} from 'web-page-mcp-shared';
import WebSocket from 'ws';

const TOKEN = 'e2e-secret';
const PORT = 17_321;
const APP_ID = 'lowcode-demo';
const INSTANCE = 'tab-1';

async function main(): Promise<void> {
  console.log('[e2e] === Test 1: Basic tool registration and call ===');
  await testBasicToolCall();

  console.log('\n[e2e] === Test 2: Target ID routing ===');
  await testTargetIdRouting();

  console.log('\n[e2e] === Test 3: Target ID tool deduplication ===');
  await testToolDeduplication();

  console.log('\n[e2e] All tests passed!');
}

async function testBasicToolCall(): Promise<void> {
  const logger = createLogger('warn');
  const registry = new SessionRegistry(logger);
  const router = new CallRouter(logger);
  const wsServer = new WsServer({
    port: PORT,
    host: '127.0.0.1',
    token: TOKEN,
    registry,
    router,
    logger,
  });
  await wsServer.start();

  const client = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });

  client.send(
    serializeMessage({
      type: 'hello',
      appId: APP_ID,
      instanceId: INSTANCE,
      token: TOKEN,
      protocolVersion: PROTOCOL_VERSION,
    })
  );

  await waitForMessage(client, (m) => m.type === 'hello_ack');
  console.log('[e2e] Test 1: handshake ok');

  client.send(
    serializeMessage({
      type: 'tools/register',
      tools: [
        {
          name: 'updateComponent',
          description: 'update a component payload',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              props: { type: 'object' },
            },
            required: ['id'],
          },
        },
      ],
    })
  );

  client.on('message', (raw) => {
    const msg = parseMessage(raw);
    if (msg.type !== 'tool/call') return;
    console.log('[e2e] Test 1: received tool/call', msg.name, msg.arguments);
    client.send(
      serializeMessage({
        type: 'tool/result',
        id: msg.id,
        ok: true,
        data: { updated: true, id: (msg.arguments as { id: string }).id },
      })
    );
  });

  await sleep(50);

  const resolved = registry.resolveSessionForFqName(`${APP_ID}__updateComponent`);
  if (!resolved) throw new Error('tool was not visible in registry');

  const outcome = await router.call(
    resolved.handle,
    `${APP_ID}__updateComponent`,
    'updateComponent',
    { id: 'comp-42', props: { label: 'hello' } },
    5_000
  );
  if (!outcome.ok) {
    throw new Error(`tool call failed: ${outcome.error.code}`);
  }
  console.log('[e2e] Test 1: tool call ok, data =', outcome.data);

  client.close();
  await sleep(50);
  await wsServer.stop();
}

async function testTargetIdRouting(): Promise<void> {
  const logger = createLogger('warn');
  const registry = new SessionRegistry(logger);
  const router = new CallRouter(logger);
  const wsServer = new WsServer({
    port: PORT + 1,
    host: '127.0.0.1',
    token: TOKEN,
    registry,
    router,
    logger,
  });
  await wsServer.start();

  // Connect two sessions with different targetIds
  const clientA = await createSessionWithTargetId(
    `ws://127.0.0.1:${PORT + 1}`,
    APP_ID,
    'tab-a',
    'order-123'
  );
  console.log('[e2e] Test 2: Session A connected with targetId=order-123');

  const clientB = await createSessionWithTargetId(
    `ws://127.0.0.1:${PORT + 1}`,
    APP_ID,
    'tab-b',
    'order-456'
  );
  console.log('[e2e] Test 2: Session B connected with targetId=order-456');

  // Register tools for both sessions
  clientA.send(
    serializeMessage({
      type: 'tools/register',
      tools: [
        {
          name: 'getSelectedNodeId',
          description: 'get selected node',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })
  );

  clientB.send(
    serializeMessage({
      type: 'tools/register',
      tools: [
        {
          name: 'getSelectedNodeId',
          description: 'get selected node',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })
  );

  await sleep(50);

  // Verify both sessions are indexed
  const stats = registry.stats();
  if (!stats.targets || !stats.targets[APP_ID]) {
    throw new Error('targetId index not created');
  }
  if (!stats.targets[APP_ID].includes('order-123')) {
    throw new Error('targetId order-123 not found in index');
  }
  if (!stats.targets[APP_ID].includes('order-456')) {
    throw new Error('targetId order-456 not found in index');
  }
  console.log('[e2e] Test 2: targetId index verified', stats.targets);

  // Test routing to specific target
  const resolvedA = registry.resolveSessionForFqName(
    `${APP_ID}__getSelectedNodeId`,
    'order-123'
  );
  if (!resolvedA) {
    throw new Error('Failed to resolve session for targetId=order-123');
  }
  console.log('[e2e] Test 2: Resolved session A for targetId=order-123');

  const resolvedB = registry.resolveSessionForFqName(
    `${APP_ID}__getSelectedNodeId`,
    'order-456'
  );
  if (!resolvedB) {
    throw new Error('Failed to resolve session for targetId=order-456');
  }
  console.log('[e2e] Test 2: Resolved session B for targetId=order-456');

  // Verify they resolve to different sessions
  if (resolvedA.handle.instanceId === resolvedB.handle.instanceId) {
    throw new Error('Both targetIds resolved to the same session');
  }
  console.log('[e2e] Test 2: Sessions are correctly isolated');

  // Test tool call to session A
  let receivedTargetA = false;
  clientA.on('message', (raw) => {
    const msg = parseMessage(raw);
    if (msg.type === 'tool/call') {
      receivedTargetA = true;
      console.log('[e2e] Test 2: Session A received tool/call');
      clientA.send(
        serializeMessage({
          type: 'tool/result',
          id: msg.id,
          ok: true,
          data: { targetId: 'order-123', nodeId: 'node-a' },
        })
      );
    }
  });

  const outcomeA = await router.call(
    resolvedA.handle,
    `${APP_ID}__getSelectedNodeId`,
    'getSelectedNodeId',
    {},
    5_000
  );

  if (!outcomeA.ok) {
    throw new Error(`Tool call to session A failed: ${outcomeA.error.code}`);
  }
  if (!receivedTargetA) {
    throw new Error('Session A did not receive tool call');
  }
  console.log('[e2e] Test 2: Tool call to session A succeeded');

  // Cleanup
  clientA.close();
  clientB.close();
  await sleep(50);
  await wsServer.stop();
}

async function testToolDeduplication(): Promise<void> {
  const logger = createLogger('warn');
  const registry = new SessionRegistry(logger);
  const router = new CallRouter(logger);
  const wsServer = new WsServer({
    port: PORT + 2,
    host: '127.0.0.1',
    token: TOKEN,
    registry,
    router,
    logger,
  });
  await wsServer.start();

  // Connect two sessions with different targetIds
  const clientA = await createSessionWithTargetId(
    `ws://127.0.0.1:${PORT + 2}`,
    APP_ID,
    'tab-a',
    'order-123'
  );

  const clientB = await createSessionWithTargetId(
    `ws://127.0.0.1:${PORT + 2}`,
    APP_ID,
    'tab-b',
    'order-456'
  );

  // Both register the same tool
  const toolDef = {
    name: 'getSelectedNodeId',
    description: 'get selected node',
    inputSchema: { type: 'object', properties: {} },
  };

  clientA.send(
    serializeMessage({
      type: 'tools/register',
      tools: [toolDef],
    })
  );

  clientB.send(
    serializeMessage({
      type: 'tools/register',
      tools: [toolDef],
    })
  );

  await sleep(50);

  // Verify tool list deduplication
  const visibleTools = registry.listVisibleTools();
  const toolCount = visibleTools.filter(
    (t) => t.name === 'getSelectedNodeId'
  ).length;

  if (toolCount !== 1) {
    throw new Error(
      `Expected 1 visible tool, got ${toolCount}. Tools: ${JSON.stringify(
        visibleTools.map((t) => t.fqName)
      )}`
    );
  }
  console.log('[e2e] Test 3: Tool deduplication verified (1 tool visible)');

  // Verify stats includes targets
  const stats = registry.stats();
  if (!stats.targets) {
    throw new Error('stats.targets should be present');
  }
  console.log('[e2e] Test 3: Stats with targets:', stats);

  // Cleanup
  clientA.close();
  clientB.close();
  await sleep(50);
  await wsServer.stop();
}

async function createSessionWithTargetId(
  url: string,
  appId: string,
  instanceId: string,
  targetId: string
): Promise<WebSocket> {
  const client = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });

  client.send(
    serializeMessage({
      type: 'hello',
      appId,
      instanceId,
      targetId,
      token: TOKEN,
      protocolVersion: PROTOCOL_VERSION,
    })
  );

  await waitForMessage(client, (m) => m.type === 'hello_ack');
  return client;
}

function waitForMessage(
  client: WebSocket,
  predicate: (msg: ReturnType<typeof parseMessage>) => boolean
): Promise<ReturnType<typeof parseMessage>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3_000);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const msg = parseMessage(raw);
        if (predicate(msg)) {
          clearTimeout(timer);
          client.off('message', onMessage);
          resolve(msg);
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err as Error);
      }
    };
    client.on('message', onMessage);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('[e2e] FAILED', err);
  process.exit(1);
});
