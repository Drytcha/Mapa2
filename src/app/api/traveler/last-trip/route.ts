import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { travelerTripState } from "@/db/schema";
import {
  parseTravelerClientId,
  parseValidatedPoint,
  type ValidatedPoint,
} from "@/lib/server/travelerValidator";

function serializeEndpoint(point: ValidatedPoint | null) {
  if (!point) return null;
  return {
    lat: point.lat,
    lon: point.lon,
    label: point.label,
    stopId: point.stopId ?? undefined,
  };
}

export async function GET(request: NextRequest) {
  const clientId = parseTravelerClientId(request);
  if (!clientId) {
    return NextResponse.json({ error: "Nieprawidłowy identyfikator klienta." }, { status: 400 });
  }
  try {
    const [row] = await db
      .select()
      .from(travelerTripState)
      .where(eq(travelerTripState.clientId, clientId))
      .limit(1);

    if (!row) {
      return NextResponse.json({ origin: null, destination: null });
    }
    const origin =
      row.originLat !== null && row.originLon !== null
        ? {
            lat: row.originLat,
            lon: row.originLon,
            label: row.originLabel || `${row.originLat.toFixed(5)}, ${row.originLon.toFixed(5)}`,
            stopId: row.originStopId ?? undefined,
          }
        : null;
    const destination =
      row.destLat !== null && row.destLon !== null
        ? {
            lat: row.destLat,
            lon: row.destLon,
            label: row.destLabel || `${row.destLat.toFixed(5)}, ${row.destLon.toFixed(5)}`,
            stopId: row.destStopId ?? undefined,
          }
        : null;

    return NextResponse.json({ origin, destination });
  } catch (error) {
    console.error("[GET /api/traveler/last-trip]", error);
    return NextResponse.json({ error: "Błąd odczytu ostatniej trasy." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
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
  const payload = (body ?? {}) as Record<string, unknown>;
  const origin = parseValidatedPoint(payload.origin);
  const destination = parseValidatedPoint(payload.destination);

  try {
    if (!origin && !destination) {
      await db.delete(travelerTripState).where(eq(travelerTripState.clientId, clientId));
      return NextResponse.json({ origin: null, destination: null });
    }

    const values = {
      clientId,
      originLat: origin?.lat ?? null,
      originLon: origin?.lon ?? null,
      originLabel: origin?.label ?? null,
      originStopId: origin?.stopId ?? null,
      destLat: destination?.lat ?? null,
      destLon: destination?.lon ?? null,
      destLabel: destination?.label ?? null,
      destStopId: destination?.stopId ?? null,
      updatedAt: new Date(),
    };

    await db
      .insert(travelerTripState)
      .values(values)
      .onConflictDoUpdate({
        target: travelerTripState.clientId,
        set: {
          originLat: values.originLat,
          originLon: values.originLon,
          originLabel: values.originLabel,
          originStopId: values.originStopId,
          destLat: values.destLat,
          destLon: values.destLon,
          destLabel: values.destLabel,
          destStopId: values.destStopId,
          updatedAt: values.updatedAt,
        },
      });

    return NextResponse.json({
      origin: serializeEndpoint(origin),
      destination: serializeEndpoint(destination),
    });
  } catch (error) {
    console.error("[PUT /api/traveler/last-trip]", error);
    return NextResponse.json({ error: "Nie udało się zapisać punktów podróży." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const clientId = parseTravelerClientId(request);
  if (!clientId) {
    return NextResponse.json({ error: "Nieprawidłowy identyfikator klienta." }, { status: 400 });
  }
  try {
    await db.delete(travelerTripState).where(eq(travelerTripState.clientId, clientId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[DELETE /api/traveler/last-trip]", error);
    return NextResponse.json({ error: "Nie udało się wyczyścić punktów." }, { status: 500 });
  }
}
