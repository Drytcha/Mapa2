import { db, isDatabaseConfigured } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isDatabaseConfigured()) {
    // Deployed without persistence: the map/planner still works, so report healthy
    // but flag that the traveler storage is disabled.
    return Response.json({ ok: true, database: "unconfigured" });
  }

  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("[GET /api/health]", error);
    return Response.json({ ok: false, database: "error" }, { status: 500 });
  }
}
