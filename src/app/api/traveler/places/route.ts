import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { travelerSavedPlaces, type TravelerSavedPlaceRow } from "@/db/schema";
import { parseTravelerClientId, parseValidatedPoint } from "@/lib/server/travelerValidator";

export const dynamic = "force-dynamic";

function serializePlace(row: TravelerSavedPlaceRow) {
  return {
    id: row.id,
    label: row.label,
    lat: row.lat,
    lon: row.lon,
    stopId: row.stopId ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const clientId = parseTravelerClientId(request);
  if (!clientId) {
    return NextResponse.json({ error: "Nieprawidłowy identyfikator klienta." }, { status: 400 });
  }
  try {
    const places = await db()
      .select()
      .from(travelerSavedPlaces)
      .where(eq(travelerSavedPlaces.clientId, clientId))
      .orderBy(desc(travelerSavedPlaces.createdAt))
      .limit(20);
    return NextResponse.json({ places: places.map(serializePlace) });
  } catch (error) {
    console.error("[GET /api/traveler/places]", error);
    return NextResponse.json({ error: "Błąd odczytu zapisanych miejsc." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const clientId = parseTravelerClientId(request);
  if (!clientId) {
    return NextResponse.json({ error: "Nieprawidłowy identyfikator klienta." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe dane JSON." }, { status: 400 });
  }
  const point = parseValidatedPoint(body);
  if (!point) {
    return NextResponse.json({ error: "Nieprawidłowe współrzędne punktu." }, { status: 400 });
  }

  try {
    const existing = await db()
      .select()
      .from(travelerSavedPlaces)
      .where(eq(travelerSavedPlaces.clientId, clientId))
      .orderBy(desc(travelerSavedPlaces.createdAt));

    const duplicate = existing.find(
      (item) =>
        Math.abs(item.lat - point.lat) < 0.00012 &&
        Math.abs(item.lon - point.lon) < 0.00012
    );
    if (duplicate) {
      const [updated] = await db()
        .update(travelerSavedPlaces)
        .set({ label: point.label, stopId: point.stopId ?? duplicate.stopId })
        .where(
          and(
            eq(travelerSavedPlaces.id, duplicate.id),
            eq(travelerSavedPlaces.clientId, clientId)
          )
        )
        .returning();
      return NextResponse.json({ place: serializePlace(updated), updated: true });
    }

    if (existing.length >= 20) {
      for (const item of existing.slice(19)) {
        await db()
          .delete(travelerSavedPlaces)
          .where(
            and(
              eq(travelerSavedPlaces.id, item.id),
              eq(travelerSavedPlaces.clientId, clientId)
            )
          );
      }
    }

    const [created] = await db()
      .insert(travelerSavedPlaces)
      .values({
        clientId,
        label: point.label,
        lat: point.lat,
        lon: point.lon,
        stopId: point.stopId,
      })
      .returning();

    return NextResponse.json({ place: serializePlace(created) }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/traveler/places]", error);
    return NextResponse.json({ error: "Nie udało się zapisać miejsca." }, { status: 500 });
  }
}
