import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Build-safe PostgreSQL client.
 *
 * Route handlers import this module, so it is evaluated while Next.js collects
 * page data during `next build`. Nothing here may throw at import time: the
 * connection string is validated and the pool is created lazily, only when the
 * first query actually runs. That keeps `next build` working in CI, Docker and
 * static-export environments where `DATABASE_URL` is not present yet.
 */

export class DatabaseConfigError extends Error {
  constructor(message = "DATABASE_URL is not configured.") {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

/** Returns the configured connection string, or `null` when it is missing/blank. */
export function getDatabaseUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when the server has a database connection string available. */
export function isDatabaseConfigured(): boolean {
  return getDatabaseUrl() !== null;
}

export type Database = NodePgDatabase<Record<string, never>>;

const globalForDb = globalThis as typeof globalThis & {
  __mapa2PgPool?: Pool;
};

/** Lazily creates (and memoises) the shared `pg` pool. Throws only when used without config. */
export function getPool(): Pool {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new DatabaseConfigError(
      "DATABASE_URL is not configured — the traveler storage API is unavailable.",
    );
  }
  globalForDb.__mapa2PgPool ??= new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return globalForDb.__mapa2PgPool;
}

let cachedDb: Database | null = null;

function resolveDb(): Database {
  cachedDb ??= drizzle(getPool());
  return cachedDb;
}

/**
 * Drop-in Drizzle instance that connects on first use instead of on import.
 * Safe to import at build time; every access is deferred until a query runs.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const instance = resolveDb();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
  has(_target, property) {
    return Reflect.has(resolveDb(), property);
  },
});

/** Closes the memoised pool — useful for tests and graceful shutdown. */
export async function closePool(): Promise<void> {
  const pool = globalForDb.__mapa2PgPool;
  globalForDb.__mapa2PgPool = undefined;
  cachedDb = null;
  await pool?.end();
}
