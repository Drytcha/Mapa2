// npm run test:progress
// Podział trasy autobusu na odcinek przejechany i przed nami (myBus 3.0).
//
// Zgłoszenie: „chcę, aby linia, która już została wykonana przez autobus, miała
// inny kolor niż ta, która ma być wykonana w przyszłości”.
import assert from "node:assert/strict";

const { splitRouteAtBus, splitRouteAtLastPassedStop, routeStopAnchors, stopSegmentRange, pastRouteColor, PAST_ROUTE_COLOR, FUTURE_ROUTE_COLOR, liveStopProgress, courseUpToStop } = await import(
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
  assert.deepEqual(atStart!.remaining, path, "na starcie kolor obejmuje całą geometrię bez białej przerwy");

  // Koniec kursu: wszystko już przejechane — trasa w całości szara.
  const atEnd = splitRouteAtBus(path, bus(998), {});
  assert.ok(atEnd, "koniec kursu daje podział z pustą częścią przed nami");
  assert.equal(atEnd!.remaining.length, 0, "na końcu nic nie zostało przed autobusem");
  assert.deepEqual(atEnd!.passed, path, "na końcu kolor obejmuje całą geometrię bez białej przerwy");
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

// Pętla: przy pierwszym kliknięciu kolejny przystanek wyznacza nitkę powrotną.
{
  const path = [...line(0, 1000, 100), ...line(900, 0, 100)];
  const stops = [0, 1000, 0].map((meters, index) => ({ ...bus(meters), sequence: index + 1 }));
  const anchors = routeStopAnchors(path, stops);
  assert.ok(anchors);
  const range = stopSegmentRange(stops, anchors, 3);
  assert.ok(range);
  const firstRead = splitRouteAtBus(path, bus(600), range!);
  assert.ok(firstRead && firstRead.index >= 10, "GPS wybrany na nitce powrotnej od pierwszego kliknięcia");
  assert.ok(lengthMeters(firstRead!.passed) > 1300, "większość trasy już przejechana");
}

// Szum GPS: przy podobnej odległości zachowujemy poprzednią nitkę nawet
// wtedy, gdy druga geometria jest minimalnie bliżej.
{
  const outbound = line(0, 1000, 100);
  const inbound = line(1000, 0, 100).map(([lat, lon]): [number, number] => [lat + 5 / 111320, lon]);
  const path = [...outbound, ...inbound];
  const jitteredBus = { ...bus(600), lat: LAT + 4 / 111320 };
  const split = splitRouteAtBus(path, jitteredBus, { nearIndex: 6 });
  assert.ok(split && split.index < outbound.length, "bliższy o kilka metrów powrót nie przeskakuje granicy");
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

// GPS poza trasą: szacujemy tylko do ostatniego potwierdzonego przystanku.
{
  const path = line(0, 1000, 50);
  const stops = [0, 300, 800, 1000].map((meters, index) => ({ ...bus(meters), sequence: index + 1 }));
  const estimated = splitRouteAtLastPassedStop(path, stops, 3);
  assert.ok(estimated);
  assert.ok(Math.abs(lengthMeters(estimated.passed) - 300) < 2);
  assert.ok(Math.abs(lengthMeters(estimated.remaining) - 700) < 2);
  assert.equal(splitRouteAtLastPassedStop(path, stops, undefined), null, "bez następnego przystanku brak zgadywania");
  assert.equal(splitRouteAtLastPassedStop(path, stops, 99), null, "nieznany następny przystanek nie wyznacza postępu");
  assert.equal(splitRouteAtLastPassedStop(path, stops, 1)?.passed.length, 0);
}

// Postęp przystanków pochodzi z numeru kolejnego przystanku GPS, nie z czasu zegara.
assert.equal(FUTURE_ROUTE_COLOR, "#16803c");
assert.deepEqual([1, 2, 3].map((sequence) => liveStopProgress(sequence, 2)), ["passed", "upcoming", "upcoming"]);
assert.deepEqual([1, 2, 3].map((sequence) => liveStopProgress(sequence, 3)), ["passed", "passed", "upcoming"]);
assert.equal(liveStopProgress(1, undefined), "unknown");
assert.equal(liveStopProgress(undefined, 2), "unknown");

// ── Trasa do wybranego przystanku (nie tylko do końca kursu) ────────────────
{
  const path = line(0, 1000, 100); // wierzchołki co 100 m
  const timed = [0, 350, 700, 1000].map((meters, index) => ({
    ...bus(meters),
    // Odjazd co 5 minut, na końcu przyjazd 20 minut po starcie.
    arrivalMs: 300_000 * (index + 1),
    departureMs: 300_000 * (index + 1),
  }));

  const middle = courseUpToStop(path, timed, 1);
  assert.ok(middle, "środkowy przystanek daje wycinek trasy");
  assert.equal(middle!.stopIndex, 1);
  assert.ok(
    Math.abs(lengthMeters(middle!.path) - 350) < 2,
    `trasa do przystanku ma 350 m (jest ${lengthMeters(middle!.path).toFixed(0)})`,
  );
  const end = middle!.path[middle!.path.length - 1];
  assert.ok(
    Math.abs((end[1] - LON0) * M_PER_DEG_LON - 350) < 2,
    "linia kończy się dokładnie pod wybranym przystankiem, a nie na wierzchołku kształtu",
  );
  assert.equal(middle!.rideMs, 600_000 - 300_000, "czas jazdy liczony od odjazdu ze startu, nie od północy");
  assert.ok(middle!.path.length < path.length, "wycinek nie zawiera dalszej części kursu");

  const atStart = courseUpToStop(path, timed, 0);
  assert.ok(atStart, "pierwszy przystanek też daje trasę (krótki odcinek)");
  assert.ok(lengthMeters(atStart!.path) < 1, "na pierwszym przystanku nie ma jeszcze jazdy");
  assert.equal(atStart!.rideMs, 0);

  const last = courseUpToStop(path, timed, 3);
  assert.ok(last);
  assert.ok(Math.abs(lengthMeters(last!.path) - 1000) < 2, "ostatni przystanek = cała trasa");
  assert.equal(last!.rideMs, 1_200_000 - 300_000, "do końca kursu jedzie się 15 minut od odjazdu ze startu");

  // Pętla: ta sama ulica w obu kierunkach — bierzemy pierwszy przejazd.
  const loop = [...line(0, 800, 100), ...line(800, 0, 100).slice(1)];
  const loopStops = [0, 400, 800, 400].map((meters, index) => ({
    ...bus(meters),
    arrivalMs: 60_000 * index,
    departureMs: 60_000 * index,
  }));
  const outward = courseUpToStop(loop, loopStops, 1);
  assert.ok(outward);
  assert.ok(
    Math.abs(lengthMeters(outward!.path) - 400) < 2,
    `przystanek na pętli obsługiwany jest w drodze „tam” (${lengthMeters(outward!.path).toFixed(0)} m)`,
  );

  assert.equal(courseUpToStop(path, timed, -1), null, "ujemny indeks odrzucony");
  assert.equal(courseUpToStop(path, timed, 99), null, "indeks poza listą odrzucony");
  assert.equal(courseUpToStop(path.slice(0, 1), timed, 1), null, "trasa z jednego punktu nie daje wycinka");
  const farAway = [{ ...bus(0), lat: 51.5, arrivalMs: 0, departureMs: 0 }];
  assert.equal(courseUpToStop(path, farAway, 0), null, "przystanek poza geometrią nie tworzy trasy");
}

console.log("OK: trasa za autobusem ma osobny kolor, a podział jest ciągły i bez dziur");
