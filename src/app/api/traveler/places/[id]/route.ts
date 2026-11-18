import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { travelerSavedPlaces } from "@/db/schema";
import { parseTravelerClientId } from "@/lib/server/travelerValidator";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const clientId = parseTravelerClientId(request);
  if (!clientId) {
    return NextResponse.json({ error: "Nieprawidłowy identyfikator klienta." }, { status: 400 });
  }
  const { id } = await context.params;
  const numericId = Number.parseInt(id, 10);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return NextResponse.json({ error: "Nieprawidłowy identyfikator miejsca." }, { status: 400 });
  }

  try {
    const deleted = await db()
      .delete(travelerSavedPlaces)
      .where(
        and(
          eq(travelerSavedPlaces.id, numericId),
          eq(travelerSavedPlaces.clientId, clientId)
        )
      )
      .returning({ id: travelerSavedPlaces.id });

    if (!deleted.length) {
      return NextResponse.json({ error: "Nie znaleziono zapisanego miejsca." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id: numericId });
  } catch (error) {
    console.error("[DELETE /api/traveler/places/:id]", error);
    return NextResponse.json({ error: "Nie udało się usunąć miejsca." }, { status: 500 });
  }
}
