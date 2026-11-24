import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import ScheduleDiffDialog from "../src/components/ScheduleDiffDialog";

const html = renderToStaticMarkup(
  React.createElement(ScheduleDiffDialog, {
    open: true,
    onClose: () => {},
    onToast: () => {},
  }),
);

assert.match(html, /Porównanie dwóch wersji rozkładu/, "renderuje nagłówek porównania rozkładów");
assert.match(html, /Eksport CSV/, "renderuje przycisk eksportu CSV");
assert.match(html, /schedule-diff-export-csv/, "ma atrybut testowy eksportu CSV");
console.log("OK: UI porównania rozkładów GTFS renderuje się poprawnie");
