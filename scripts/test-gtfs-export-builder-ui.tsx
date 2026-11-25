import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CustomGtfsBuilderDialog from "../src/components/CustomGtfsBuilderDialog";
import CustomGtfsMapDrawToolbar from "../src/components/CustomGtfsMapDrawToolbar";
import LineRouteEditorPanel from "../src/components/LineRouteEditorPanel";

// 1. SSR smoke test: CustomGtfsBuilderDialog
const builderHtml = renderToStaticMarkup(
  React.createElement(CustomGtfsBuilderDialog, {
    open: true,
    onClose: () => {},
    onShowOnMap: () => {},
  }),
);
assert.ok(
  builderHtml.includes("Kreator nowych linii i eksport paczki GTFS"),
  "Dialog title should render",
);
assert.ok(
  builderHtml.includes("Nowa linia"),
  "Create new custom line button should render",
);
assert.ok(
  builderHtml.includes("1. Linia i warianty"),
  "Tab 1 should render",
);
assert.ok(
  builderHtml.includes("2. Przystanki i trasa"),
  "Tab 2 should render",
);
assert.ok(
  builderHtml.includes("3. Rozkład i czasy"),
  "Tab 3 should render",
);
assert.ok(
  builderHtml.includes("4. Eksport GTFS"),
  "Tab 4 should render",
);
assert.ok(
  builderHtml.includes("Połącz i eksportuj GTFS (.zip)"),
  "Export GTFS ZIP CTA should render",
);

// 2. SSR smoke test: LineRouteEditorPanel with GIS / GTFS export wiring
const editorHtml = renderToStaticMarkup(
  React.createElement(LineRouteEditorPanel, {
    initialLineShort: "2",
    initialVariantKey: null,
    onClose: () => {},
    onMapStateChange: () => {},
    handlersRef: { current: null },
    onToast: () => {},
  }),
);
assert.ok(
  editorHtml.includes("line-route-editor-panel"),
  "LineRouteEditorPanel shell should render",
);

const editorSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/LineRouteEditorPanel.tsx"),
  "utf8",
);
for (const marker of [
  "Eksport GIS / GTFS",
  'data-testid="editor-export-shapes"',
  'data-testid="editor-export-geojson"',
  'data-testid="editor-export-gpx"',
]) {
  assert.ok(
    editorSrc.includes(marker),
    `LineRouteEditorPanel.tsx should contain ${marker}`,
  );
}

// 3. SSR smoke test: CustomGtfsMapDrawToolbar (rysowanie trasy + wskazywanie przystanku na mapie)
const drawToolbarHtml = renderToStaticMarkup(
  React.createElement(CustomGtfsMapDrawToolbar, {
    session: {
      kind: "draw-route",
      lineId: "l1",
      variantId: "v1",
      lineShort: "S5",
      variantName: "Szczawienko → Park Nauki",
      color: "#1d4ed8",
      initialPath: [
        [50.815, 16.292],
        [50.771, 16.284],
      ],
      stops: [
        { id: "s1", name: "Szczawienko", lat: 50.815, lon: 16.292, sequence: 1 },
        { id: "s2", name: "Park Nauki", lat: 50.771, lon: 16.284, sequence: 2 },
      ],
    },
    onMapStateChange: () => {},
    handlersRef: { current: null },
    onApplyRoute: () => {},
    onPickStopCoords: () => {},
    onCancel: () => {},
  }),
);
for (const marker of [
  "Rysowanie trasy GTFS",
  "Klikaj trasę",
  "Przesuwaj",
  "Usuń pkt",
  "Ramka",
  "Po drogach (OSRM)",
  "Zastosuj trasę i wróć",
]) {
  assert.ok(
    drawToolbarHtml.includes(marker),
    `CustomGtfsMapDrawToolbar should render "${marker}"`,
  );
}

const pickStopHtml = renderToStaticMarkup(
  React.createElement(CustomGtfsMapDrawToolbar, {
    session: {
      kind: "pick-stop",
      lineId: "l1",
      variantId: "v1",
      lineShort: "S5",
      variantName: "Szczawienko → Park Nauki",
      color: "#1d4ed8",
      existingPath: [],
      stops: [],
    },
    onMapStateChange: () => {},
    handlersRef: { current: null },
    onApplyRoute: () => {},
    onPickStopCoords: () => {},
    onCancel: () => {},
  }),
);
assert.ok(
  pickStopHtml.includes("Kliknij na mapie lokalizację nowego przystanku"),
  "Pick-stop banner should render",
);

const builderSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/CustomGtfsBuilderDialog.tsx"),
  "utf8",
);
assert.ok(
  builderSrc.includes('data-testid="custom-gtfs-draw-on-map"'),
  "CustomGtfsBuilderDialog should expose map route drawing button",
);
assert.ok(
  builderSrc.includes('data-testid="custom-gtfs-pick-stop-map"'),
  "CustomGtfsBuilderDialog should expose map stop picking button",
);

console.log(
  "✓ GTFS export & custom line builder UI SSR tests passed (CustomGtfsBuilderDialog + CustomGtfsMapDrawToolbar + LineRouteEditorPanel export bar)",
);
