import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import RouteAuditDialog from "../src/components/RouteAuditDialog";

const html = renderToStaticMarkup(
  React.createElement(RouteAuditDialog, {
    open: true,
    onClose: () => {},
    onFixInEditor: () => {},
    onShowOnMap: () => {},
    onToast: () => {},
  }),
);

assert.match(html, /Audyt jakości tras GTFS/, "renderuje nagłówek audytu jakości tras");
assert.match(html, /Mapa błędów/, "renderuje przycisk Mapy błędów");
assert.match(html, /audit-rescan/, "renderuje przycisk ponownego skanowania");
console.log("OK: UI audytu jakości tras GTFS renderuje się poprawnie");
