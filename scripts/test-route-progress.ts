// npm run test:progress
// Podział trasy autobusu na odcinek przejechany i przed nami (myBus 3.0).
//
// Zgłoszenie: „chcę, aby linia, która już została wykonana przez autobus, miała
// inny kolor niż ta, która ma być wykonana w przyszłości”.
import assert from "node:assert/strict";

const { splitRouteAtBus, pastRouteColor, PAST_ROUTE_COLOR } = await import(
  "../src/lib/routeProgress"
);

const LAT = 50.77;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const LON0 = 16.28;
const at = (meters: number): [number, number] => [LAT, LON0 + meters / M_PER_DEG_LON];
const bus = (meters: number) => ({ lat: LAT, lon: LON0 + meters / M_PER_DEG_LON });

const line = (from: number, to: number, step: number): Array<[number, number]> => {
  const points: Array<[number, number]> = [];
  const dir = to >= from ? 1 : -1;
  for (let m = from; dir > 0 ? m <= to : m >= to; m += dir * step) points.push(at(m));
  if (!points.length || Math.abs(points[points.length - 1][1] - at(to)[1]) > 1e-9) points.push(at(to));
  return points;
};

const lengthMeters = (path: Array<[number, number]>) => {
  let sum = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const dx = (path[i + 1][1] - path[i][1]) * M_PER_DEG_LON;
    const dy = (path[i + 1][0] - path[i][0]) * 111_320;
    sum += Math.hypot(dx, dy);
  }
  return sum;
};

// ── 1. Autobus między wierzchołkami: podział wypada dokładnie pod nim ────────
{
  const path = line(0, 1000, 100); // wierzchołki co 100 m
  const split = splitRouteAtBus(path, bus(430));
  assert.ok(split, "podział musi się udać dla autobusu na trasie");
  assert.ok(Math.abs(lengthMeters(split!.passed) - 430) < 2, `przejechane ≈ 430 m (jest ${lengthMeters(split!.passed).toFixed(0)})`);
  assert.ok(Math.abs(lengthMeters(split!.remaining) - 570) < 2, `przed nami ≈ 570 m (jest ${lengthMeters(split!.remaining).toFixed(0)})`);
  const passedEnd = split!.passed[split!.passed.length - 1];
  const remainingStart = split!.remaining[0];
  assert.deepEqual(passedEnd, remainingStart, "oba odcinki stykają się w jednym punkcie (brak dziury)");
  assert.ok(Math.abs((passedEnd[1] - LON0) * M_PER_DEG_LON - 430) < 2, "punkt podziału jest pod autobusem, nie na wierzchołku");
  const total = lengthMeters(split!.passed) + lengthMeters(split!.remaining);
  assert.ok(Math.abs(total - 1000) < 3, "suma obu kolorów to cała trasa — nic nie znika");
}

// ── 2. GPS poza trasą / krańce kursu ────────────────────────────────────────
{
  const path = line(0, 1000, 50);
  assert.equal(splitRouteAtBus(path, { lat: 50.78, lon: LON0 }, {}), null, "autobus 1 km od trasy → brak podziału");
  assert.equal(splitRouteAtBus([at(0)], bus(0), {}), null, "trasa z jednego punktu → brak podziału");

  // Start kursu: nie ma czego wyszarzać — cała trasa jest przed autobusem.
  const atStart = splitRouteAtBus(path, bus(2), {});
  assert.ok(atStart, "start kursu daje podział z pustą częścią przejechaną");
  assert.equal(atStart!.passed.length, 0, "na starcie nic nie jest jeszcze przejechane");
  assert.ok(lengthMeters(atStart!.remaining) > 990, "cała trasa jest przed autobusem");

  // Koniec kursu: wszystko już przejechane — trasa w całości szara.
  const atEnd = splitRouteAtBus(path, bus(998), {});
  assert.ok(atEnd, "koniec kursu daje podział z pustą częścią przed nami");
  assert.equal(atEnd!.remaining.length, 0, "na końcu nic nie zostało przed autobusem");
  assert.ok(lengthMeters(atEnd!.passed) > 990, "cała trasa jest już za autobusem");
}

// ── 3. Trasa „tam i z powrotem”: ciągłość granicy, bez skoku na drugą nitkę ──
{
  const outbound = line(0, 1200, 100);
  const inbound = line(1100, 0, 100);
  const path = [...outbound, ...inbound];
  const forward = splitRouteAtBus(path, bus(600));
  assert.ok(forward);
  // Po przejechaniu połowy autobus zawraca: kolejny odczyt nie może przeskoczyć
  // na nitkę powrotną tylko dlatego, że leży geometrycznie bliżej.
  const back = splitRouteAtBus(path, bus(600), { nearIndex: 24 });
  assert.ok(back, "podział na nitce powrotnej");
  assert.ok(back!.index >= outbound.length - 2, `granica zostaje na nitce powrotnej (index ${back!.index})`);
  assert.ok(back!.passed.length > forward!.passed.length, "przejechany odcinek rośnie, nie maleje");
}

// ── 4. Kolor odcinka przejechanego jest inny i neutralny ────────────────────
{
  assert.notEqual(pastRouteColor(false), pastRouteColor(true), "inny odcień na jasnych i ciemnych kafelkach");
  assert.equal(pastRouteColor(false), PAST_ROUTE_COLOR.light);
  assert.equal(pastRouteColor(true), PAST_ROUTE_COLOR.dark);
  for (const color of [PAST_ROUTE_COLOR.light, PAST_ROUTE_COLOR.dark]) {
    assert.match(color, /^#[0-9a-f]{6}$/, "kolor w formacie hex");
    // Neutralna szarość: składowe R/G/B blisko siebie — nie wygląda jak inna linia.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 24, `szary odcień przejechanej trasy (${color})`);
  }
}

console.log("OK: trasa za autobusem ma osobny kolor, a podział jest ciągły i bez dziur");
