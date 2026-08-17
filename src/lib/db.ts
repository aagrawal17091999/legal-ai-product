import { Pool } from "pg";

let pool: Pool | null = null;

/**
 * Per-instance pool ceiling, exported so callers that fan out (retrieval) can
 * size their own concurrency below it rather than guessing.
 *
 * Raised from 10 to 20 in production: a single agent turn issues several
 * concurrent `search_fresh` calls, each expanding to N queries × 3 lanes, and
 * at 10 the surplus waited past `connectionTimeoutMillis` and failed the search
 * outright. Real connections = instances × this (+ cron + psql) against
 * Postgres `max_connections` = 100, so 2 pm2 instances × 20 = 40 leaves ample
 * headroom. `search.ts` also bounds its own fan-out, which is the durable fix —
 * this just stops the pool being the first thing to break.
 */
export const DB_POOL_MAX =
  Number(process.env.DB_POOL_MAX) || (process.env.NODE_ENV === "production" ? 20 : 5);

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env.local (see .env.local.example)"
    );
  }

  // Sizing rationale lives on DB_POOL_MAX above. For real concurrency growth,
  // point DATABASE_URL at the transaction-mode PgBouncer in deploy/pgbouncer/
  // (port 6432) rather than enlarging this per-process pool further.
  pool = new Pool({
    connectionString,
    max: DB_POOL_MAX,
    // Hand idle connections back so a traffic burst doesn't pin `max` forever.
    idleTimeoutMillis: 30_000,
    // Fail fast when the pool is saturated instead of hanging the event loop,
    // which under load cascades into timeouts for every user.
    connectionTimeoutMillis: 10_000,
  });

  // An idle client can emit 'error' out-of-band (Postgres restart, network blip,
  // OOM-killer on the shared box). With no listener Node treats it as unhandled
  // and crashes the whole app process, dropping every in-flight request. Swallow
  // it: the pool discards the dead client and the next query opens a fresh one.
  pool.on("error", (err) => {
    console.error("[db] idle client error (recovered):", err.message);
  });

  return pool;
}

// Proxy that lazily initializes the pool on first query
const db = new Proxy({} as Pool, {
  get(_target, prop: string | symbol) {
    const p = getPool();
    const value = (p as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") {
      return value.bind(p);
    }
    return value;
  },
});

export default db;
