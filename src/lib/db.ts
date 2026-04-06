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

  pool = new Pool({
    connectionString,
    max: process.env.NODE_ENV === "production" ? 20 : 5,
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
