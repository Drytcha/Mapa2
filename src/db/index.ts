import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function createDatabase() {
  // Next.js imports route modules during `next build`. Configuration belongs at
  // the first actual query, never at module scope or in the client bundle.
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required at runtime for PostgreSQL-backed requests.");
  }
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  pool.on("error", (error) => console.error("[postgres] idle connection error:", error.name));
  return drizzle(pool, { schema });
}

const shared = globalThis as typeof globalThis & {
  __mapPlanerDatabase?: ReturnType<typeof createDatabase>;
};

/** Lazily create one pool per server process, including across development reloads. */
export function db(): ReturnType<typeof createDatabase> {
  return (shared.__mapPlanerDatabase ??= createDatabase());
}
