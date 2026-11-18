// Diagnostyka: które brygady linii 30 widzi silnik dla danej daty, dla danej paczki GTFS.
import fs from "node:fs";

process.env.NEXT_PUBLIC_STATIC_EXPORT = "1";
const [zipPath, dateId = "20261201", line = "30"] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(zipPath));
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("walbrzych-gtfs.zip")) return new Response(bytes, { status: 200 });
  if (url.startsWith("http")) throw new Error("offline");
  return nativeFetch(input, init);
}) as typeof fetch;

const { loadBrigades } = await import("../src/lib/engine/brigades");
const res = await loadBrigades([], line, dateId);
console.log(`archive=${zipPath.split("/").at(-1)} date=${dateId} line=${line}`);
console.log(" error:", res.error ?? "-", "| services:", res.serviceIds?.join(","));
console.log(" notice:", res.notice ?? "-");
for (const b of res.items) {
  console.log(
    `  ${b.number.padEnd(6)} ${b.operatorLabel.padEnd(5)} trips=${b.tripCount} lines=${b.lineIds.join("/")} ${b.workSpans.join(" ; ")}`
  );
}
console.log(" total items:", res.items.length);
process.exit(0);
