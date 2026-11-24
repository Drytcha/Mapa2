import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CustomGtfsBuilderDialog from "../src/components/CustomGtfsBuilderDialog";
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

console.log(
  "✓ GTFS export & custom line builder UI SSR tests passed (CustomGtfsBuilderDialog + LineRouteEditorPanel export bar)",
);
