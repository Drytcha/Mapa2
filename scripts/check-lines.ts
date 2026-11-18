// Diagnostyka: katalog linii z paczki GTFS (full) + przykładowy overlay trasy.
// Użycie: npx tsx scripts/check-lines.ts <GTFS (full).zip>
import fs from "node:fs";
process.env.NEXT_PUBLIC_STATIC_EXPORT = "1";
const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (String(input).includes("walbrzych-gtfs.zip")) return new Response(bytes, { status: 200 });
  throw new Error("offline");
}) as typeof fetch;
const { getLineCatalogue } = await import("../src/lib/engine/lineRoutes");
const { getBrigadeShapeOverlay } = await import("../src/lib/engine/gtfsStore");
const lines = await getLineCatalogue();
console.log(`linie: ${lines.length} -> ${lines.map((l) => l.shortName).join(", ")}`);
for (const l of lines) {
  const main = l.variants.filter((v) => v.main).map((v) => `${v.headsign.slice(0, 28)} (${v.stopCount} p., ${(v.lengthMeters / 1000).toFixed(1)} km, ${v.refCount}k)`);
  console.log(`${l.shortName.padEnd(3)} od ${l.from} wariantów=${String(l.variants.length).padStart(2)} kursów(dzień rob. ${l.refDate})=${String(l.refTrips).padStart(3)} | ${main.join("  <>  ")}`);
}
const l30 = lines.find((l) => l.shortName === "30");
console.log("\nLinia 30:", l30 ? `OK, ${l30.variants.length} warianty, od ${l30.from}` : "BRAK!");
const ov = await getBrigadeShapeOverlay("Linia 30", l30!.color, l30!.variants.map((v) => v.representativeTripId));
console.log("overlay linii 30: polylines", ov?.polylines.length, "punktów", ov?.polylines.reduce((s, p) => s + p.length, 0), "przystanków", ov?.stops.length);
const bad = lines.filter((l) => l.variants.some((v) => v.path.length < 2));
console.log("linie z pustą geometrią:", bad.length);
process.exit(0);
