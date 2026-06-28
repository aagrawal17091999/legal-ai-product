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
  const max = Number(process.env.DB_POOL_MAX) || (process.env.NODE_ENV === "production" ? 20 : 5);
  pool = new Pool({ connectionString, max });

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
