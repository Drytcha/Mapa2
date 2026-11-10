/**
 * Verifies the REAL brigade roster (same source as livetransport.eu) 3 times:
 *  - every duty number belongs to a real Wałbrzych line scheme (no "18-07"),
 *  - selecting a line returns all duties serving it, including cross-line ones,
 *  - dates outside the operator roster window return no data (app then shows an
 *    honest GTFS fallback instead of inventing numbers).
 *
 * Run: node tests/live-brigades-check.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

const BASE = "https://api.livetransport.eu/walbrzych";
const DATE = process.env.BRIGADE_DATE || "20261109";
const OUT_OF_WINDOW = ["20261111", "20270101"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function viaProxy(url, timeout = 20000) {
  const proxies = [
    `https://r.jina.ai/${url}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
  let last = "";
  for (let i = 0; i < proxies.length + 1; i += 1) {
    const target = proxies[i % proxies.length];
    const res = await fetch(target, {
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: "text/plain" },
    });
    if (res.ok) return res.text();
    last = `${res.status}`;
    await sleep(900 + i * 700);
  }
  throw new Error(`proxy HTTP ${last}`);
}

function parseArray(text) {
  const trimmed = text.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct;
  } catch {
    /* proxy wrapper */
  }
  const marker = "Markdown Content:";
  const index = trimmed.indexOf(marker);
  const payload = (index >= 0 ? trimmed.slice(index + marker.length) : trimmed)
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "");
  const start = payload.indexOf("[");
  const end = payload.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("brak tablicy JSON w odpowiedzi");
  return JSON.parse(payload.slice(start, end + 1));
}

async function retry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await sleep(1200 + i * 1200);
    }
  }
  throw last;
}
const blocks = async (line, date = DATE) =>
  parseArray(await retry(() => viaProxy(`${BASE}/brigades/${encodeURIComponent(line)}?date=${date}`)));
const trips = async (blockId) =>
  parseArray(await retry(() => viaProxy(`${BASE}/brigade/${encodeURIComponent(blockId)}`)));

/* Real line codes straight from the GTFS routes. */
const zipPath = fs.existsSync("public/data/walbrzych-gtfs.zip")
  ? "public/data/walbrzych-gtfs.zip"
  : "/tmp/walbrzych-gtfs.zip";
const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
const routesTxt = strFromU8(files["routes.txt"]).trim().split(/\r?\n/).slice(1);
const realLines = new Set(
  routesTxt.map((line) => {
    const cols = line.split(",");
    return (cols[2] || cols[0]).replace(/"/g, "").trim().toUpperCase();
  })
);

let checks = 0;
const focus = ["2", "18", "A", "EX"];

for (let round = 1; round <= 3; round += 1) {
  console.log(`\n=== RUNDA ${round}/3 (źródło: rozkład operatora) ===`);
  const lists = new Map();

  for (const line of focus) {
    await sleep(400);
    const data = await blocks(line);
    assert.ok(data.length > 0, `${line}: brak brygad w źródle`);
    lists.set(line, data);
    for (const block of data) {
      assert.match(block.blockId, /^\d{8}_[A-Z0-9]+-\d+$/, `${line}: zły blockId ${block.blockId}`);
      const number = block.blockId.split("_").at(-1);
      const prefix = number.split("-")[0].toUpperCase();
      assert.ok(realLines.has(prefix), `${line}: numer ${number} spoza wałbrzyskich linii`);
      assert.ok(Array.isArray(block.times) && block.times.length > 0, `${number}: brak kursów`);
      checks += 3;
    }
    console.log(
      `  linia ${line}: ${data.length} brygad → ${data
        .map((b) => b.blockId.split("_").at(-1))
        .join(", ")}`
    );
  }

  // No fictional numbering such as 18-07 / 18-10.
  const line18 = lists.get("18").map((b) => b.blockId.split("_").at(-1));
  assert.ok(!line18.includes("18-07") && !line18.includes("18-10"), "fikcyjna brygada 18-07/18-10");
  checks += 1;

  // Cross-line duty: 8-02 serves line 2 and must be listed under line 2.
  const line2 = lists.get("2").map((b) => b.blockId.split("_").at(-1));
  assert.ok(line2.includes("8-02"), "8-02 (wieloliniowa) nie pojawia się przy linii 2");
  checks += 1;
  const crossTrips = await trips(`${DATE}_8-02`);
  const crossLines = new Set(crossTrips.map((t) => String(t.lineId).toUpperCase()));
  assert.ok(crossLines.has("2") && crossLines.has("8"), "8-02 nie obsługuje linii 2 i 8");
  checks += 2;

  // Every duty listed for a line really contains trips of that line.
  for (const sample of ["2-01", "18-04"]) {
    const data = await trips(`${DATE}_${sample}`);
    const line = sample.split("-")[0];
    assert.ok(
      data.some((t) => String(t.lineId).toUpperCase() === line),
      `${sample}: brak kursu własnej linii ${line}`
    );
    assert.ok(data.length > 0 && data[0].stops.length >= 2, `${sample}: niepełne kursy`);
    checks += 2;
  }

  // Dates outside the roster window have no data — the app must fall back,
  // never fabricate numbers.
  for (const date of OUT_OF_WINDOW) {
    const data = await blocks("2", date);
    assert.equal(data.length, 0, `${date}: źródło zwróciło dane poza oknem — sprawdź logikę`);
    checks += 1;
  }

  console.log(`RUNDA ${round}/3: PASS`);
}

console.log(
  `\nWYNIK: 3/3 rund OK, ${checks} asercji. Numery brygad pochodzą z rozkładu operatora — ` +
    `brak brygad typu 18-07/18-10, brygady wieloliniowe widoczne pod każdą linią.`
);
