/**
 * Minimal counting semaphore.
 *
 * Used to bound how many database round-trips a SINGLE request may have in
 * flight at once. The agent fans out aggressively — several concurrent
 * `search_fresh` tool calls, each expanding into N rewritten queries × 3
 * retrieval lanes — so one question can queue 30+ statements against a pg pool
 * capped at `DB_POOL_MAX` (10 by default). Anything that waits longer than
 * `connectionTimeoutMillis` for a client is rejected with
 * "timeout exceeded when trying to connect", which the agent then sees as a
 * failed tool call: the turn loses a whole search and usually spends an extra
 * model round re-issuing it.
 *
 * Raising the pool alone just moves that cliff; the fan-out is unbounded, so
 * the fix is to bound it. Queries queue here (cheaply, in memory) instead of
 * racing for pool clients and timing out.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  private async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    // Hand the permit straight to the next waiter rather than incrementing —
    // otherwise a permit can be stolen by a fresh caller and a queued waiter
    // starves.
    if (next) next();
    else this.permits++;
  }

  /**
   * Run `fn` holding one permit. The permit is always returned, including when
   * `fn` throws, so a failing query cannot leak capacity.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Map `items` through `fn` with at most `limit` running concurrently.
 * Order of results matches order of input, like Promise.all.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const sem = new Semaphore(limit);
  return Promise.all(items.map((item, i) => sem.run(() => fn(item, i))));
}
