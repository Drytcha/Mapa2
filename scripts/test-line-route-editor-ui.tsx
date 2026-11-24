import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import LineRouteEditorPanel from "../src/components/LineRouteEditorPanel";

const html = renderToStaticMarkup(
  React.createElement(LineRouteEditorPanel, {
    initialLineShort: "7",
    initialVariantKey: null,
    onClose: () => {},
    onMapStateChange: () => {},
    handlersRef: { current: null },
    onToast: () => {},
  }),
);

assert.match(html, /Edytor przebiegu linii/, "renderuje nagłówek edytora przebiegu linii");
assert.match(html, /Planer/, "renderuje przycisk powrotu do Planera");
assert.match(html, /line-route-editor-panel/, "ma atrybut testowy panelu edytora");
console.log("OK: UI edytora przebiegu linii renderuje się poprawnie");
