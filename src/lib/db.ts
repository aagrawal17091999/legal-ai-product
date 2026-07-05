import { Pool } from "pg";

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env.local (see .env.local.example)"
    );
  }

  // Per-instance pool ceiling. Under load many serverless instances (app traffic
  // + overlapping batch-worker invocations) each open their own pool, so the sum
  // can exhaust Postgres `max_connections`. Point DATABASE_URL at a transaction-
  // mode pooler (PgBouncer / Neon pooled / Supavisor) and keep this modest; raise
  // DB_POOL_MAX only with headroom to spare.
  // Default kept modest: under pm2 CLUSTER mode this pool exists once PER
  // instance, so real connections = instances × max (+ staging + cron + psql)
  // against Postgres max_connections=100. 10 × a few instances stays safe;
  // scale concurrency out with PgBouncer (deploy/pgbouncer/) rather than a big
  // per-process pool.
  const max = Number(process.env.DB_POOL_MAX) || (process.env.NODE_ENV === "production" ? 10 : 5);
  pool = new Pool({
    connectionString,
    max,
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
