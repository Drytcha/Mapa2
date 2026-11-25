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

const nsNhHtml = renderToStaticMarkup(
  React.createElement(ScheduleDiffDialog, {
    open: true,
    initialPreset: "ns-nh",
    onClose: () => {},
    onToast: () => {},
  }),
);
assert.match(
  nsNhHtml,
  /Porównywarka rozkładów NS vs NH/,
  "tryb initialPreset='ns-nh' od razu wyświetla nagłówek porównywarki NS vs NH",
);
assert.match(
  nsNhHtml,
  /niedzieli niehandlowej.*niedzielą handlową/,
  "tryb initialPreset='ns-nh' wyświetla opis porównania NS vs NH",
);
console.log("OK: UI porównania rozkładów GTFS + porównywarki NS vs NH renderuje się poprawnie");
