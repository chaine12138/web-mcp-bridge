import {
  SOFT_OFFLINE_MS,
  TOOL_NAMESPACE_SEP,
  type ToolDescriptor,
} from 'web-page-mcp-shared';
import type { Logger } from './logger.js';

/**
 * In-memory registry of live host sessions and the tools they expose.
 *
 * Key: (appId, instanceId) pair. Tools exposed to the MCP agent are prefixed
 * with `<appId>__`. When two instances share the same appId, only the most
 * recently handshaked one is visible to the agent.
 */

export interface SessionHandle {
  appId: string;
  instanceId: string;
  targetId?: string;
  sessionId: string;
  send: (msg: string) => void;
  close: () => void;
}

interface StoredSession {
  handle: SessionHandle;
  tools: Map<string, ToolDescriptor>;
  /** Monotonic handshake order; higher == newer. */
  seq: number;
  /** If set, session is in the soft-offline window. */
  softOfflineTimer?: NodeJS.Timeout;
}

export interface FlatTool {
  /** Namespaced tool name exposed to the MCP agent. */
  fqName: string;
  /** Original tool name as registered by the host. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  appId: string;
}

export type ListChangedListener = () => void;

export class SessionRegistry {
  private readonly sessions = new Map<string, StoredSession>();
  /** Index: "appId::targetId" → Set<instanceId> for target-based routing */
  private readonly targetIndex = new Map<string, Set<string>>();
  private seqCounter = 0;
  private readonly listeners = new Set<ListChangedListener>();

  constructor(private readonly logger: Logger) {}

  private key(appId: string, instanceId: string): string {
    return `${appId}::${instanceId}`;
  }

  private targetKey(appId: string, targetId: string): string {
    return `${appId}::${targetId}`;
  }

  /** Register a new session right after handshake succeeds. */
  addSession(handle: SessionHandle): void {
    const key = this.key(handle.appId, handle.instanceId);
    const existing = this.sessions.get(key);
    if (existing?.softOfflineTimer) {
      clearTimeout(existing.softOfflineTimer);
    }
    const stored: StoredSession = existing
      ? { ...existing, handle, seq: ++this.seqCounter, softOfflineTimer: undefined }
      : { handle, tools: new Map(), seq: ++this.seqCounter };
    this.sessions.set(key, stored);

    // Update target index
    if (handle.targetId) {
      const tKey = this.targetKey(handle.appId, handle.targetId);
      if (!this.targetIndex.has(tKey)) {
        this.targetIndex.set(tKey, new Set());
      }
      this.targetIndex.get(tKey)!.add(handle.instanceId);
    }

    // Warn if this appId already has a different live instance.
    const siblings = [...this.sessions.values()].filter(
      (s) => s.handle.appId === handle.appId && s.handle.instanceId !== handle.instanceId
    );
    if (siblings.length > 0) {
      this.logger.warn('session_multi_instance_takeover', {
        appId: handle.appId,
        instanceId: handle.instanceId,
      });
    }
  }

  /** Mark the session as soft-offline; actual removal happens after the window. */
  markDisconnected(appId: string, instanceId: string): void {
    const key = this.key(appId, instanceId);
    const stored = this.sessions.get(key);
    if (!stored) return;
    if (stored.softOfflineTimer) return; // already pending
    
    // Clean up target index
    if (stored.handle.targetId) {
      const tKey = this.targetKey(appId, stored.handle.targetId);
      const instances = this.targetIndex.get(tKey);
      if (instances) {
        instances.delete(instanceId);
        if (instances.size === 0) {
          this.targetIndex.delete(tKey);
        }
      }
    }
    
    stored.softOfflineTimer = setTimeout(() => {
      this.sessions.delete(key);
      this.logger.info('session_evicted', { appId, instanceId });
      this.emitListChanged();
    }, SOFT_OFFLINE_MS);
  }

  registerTools(
    appId: string,
    instanceId: string,
    tools: ToolDescriptor[]
  ): void {
    const stored = this.sessions.get(this.key(appId, instanceId));
    if (!stored) return;
    for (const t of tools) stored.tools.set(t.name, t);
    this.emitListChanged();
  }

  unregisterTools(appId: string, instanceId: string, names: string[]): void {
    const stored = this.sessions.get(this.key(appId, instanceId));
    if (!stored) return;
    for (const n of names) stored.tools.delete(n);
    this.emitListChanged();
  }

  /** Return the currently visible tool list (after multi-instance dedupe). */
  listVisibleTools(): FlatTool[] {
    // For each appId, keep only the most recent session (highest seq).
    const perApp = new Map<string, StoredSession>();
    for (const stored of this.sessions.values()) {
      const cur = perApp.get(stored.handle.appId);
      if (!cur || stored.seq > cur.seq) perApp.set(stored.handle.appId, stored);
    }
    const out: FlatTool[] = [];
    const seen = new Set<string>();
    for (const stored of perApp.values()) {
      for (const t of stored.tools.values()) {
        const fqName = `${stored.handle.appId}${TOOL_NAMESPACE_SEP}${t.name}`;
        if (seen.has(fqName)) continue;
        seen.add(fqName);
        out.push({
          fqName,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          appId: stored.handle.appId,
        });
      }
    }
    return out;
  }

  /** Resolve an fqName to the handle that should receive the call, if any. */
  resolveSessionForFqName(
    fqName: string,
    targetId?: string
  ): { handle: SessionHandle; toolName: string } | undefined {
    const sepIdx = fqName.indexOf(TOOL_NAMESPACE_SEP);
    if (sepIdx <= 0) return undefined;
    const appId = fqName.slice(0, sepIdx);
    const toolName = fqName.slice(sepIdx + TOOL_NAMESPACE_SEP.length);

    let best: StoredSession | undefined;
    
    // If targetId is specified, only search within that target
    if (targetId) {
      const tKey = this.targetKey(appId, targetId);
      const instances = this.targetIndex.get(tKey);
      if (!instances) return undefined;
      
      for (const stored of this.sessions.values()) {
        if (stored.handle.appId !== appId) continue;
        if (!instances.has(stored.handle.instanceId)) continue;
        if (!stored.tools.has(toolName)) continue;
        if (!best || stored.seq > best.seq) best = stored;
      }
    } else {
      // Default behavior: search all instances
      for (const stored of this.sessions.values()) {
        if (stored.handle.appId !== appId) continue;
        if (!stored.tools.has(toolName)) continue;
        if (!best || stored.seq > best.seq) best = stored;
      }
    }
    
    return best ? { handle: best.handle, toolName } : undefined;
  }

  stats(): { sessions: number; tools: number; targets?: Record<string, string[]> } {
    const base = {
      sessions: this.sessions.size,
      tools: this.listVisibleTools().length,
    };
    
    // Build targets info
    const targets: Record<string, string[]> = {};
    for (const [tKey, instances] of this.targetIndex.entries()) {
      const parts = tKey.split('::');
      const appId = parts[0];
      const targetId = parts[1];
      if (!appId || !targetId) continue;
      if (!targets[appId]) {
        targets[appId] = [];
      }
      targets[appId].push(targetId);
    }
    
    return Object.keys(targets).length > 0 ? { ...base, targets } : base;
  }

  onListChanged(l: ListChangedListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emitListChanged(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        this.logger.error('list_changed_listener_error', {
          message: (err as Error).message,
        });
      }
    }
  }
}
