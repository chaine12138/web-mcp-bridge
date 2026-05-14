/**
 * Minimal typed event emitter tailored to the AgentTool public events.
 * Avoids a Node EventEmitter dependency so the SDK stays browser-first.
 */

export type Listener<T> = (payload: T) => void;

export class TypedEmitter<Events> {
  private readonly handlers = new Map<keyof Events, Set<Listener<unknown>>>();

  on<K extends keyof Events>(event: K, handler: Listener<Events[K]>): void {
    let bucket = this.handlers.get(event);
    if (!bucket) {
      bucket = new Set();
      this.handlers.set(event, bucket);
    }
    bucket.add(handler as Listener<unknown>);
  }

  off<K extends keyof Events>(event: K, handler: Listener<Events[K]>): void {
    const bucket = this.handlers.get(event);
    if (!bucket) return;
    bucket.delete(handler as Listener<unknown>);
    if (bucket.size === 0) this.handlers.delete(event);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const bucket = this.handlers.get(event);
    if (!bucket) return;
    for (const handler of [...bucket]) {
      try {
        (handler as Listener<Events[K]>)(payload);
      } catch {
        /* listeners must not break the SDK */
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
