import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ShapeOverlayControl } from "../src/components/MapOverlays";

const html = renderToStaticMarkup(
  <ShapeOverlayControl title="Linia 7 → centrum" onClear={() => {}} />
);
assert.match(html, /Linia 7 → centrum/);
assert.match(html, /aria-label="Ukryj przebieg z mapy"/);
assert.match(html, /<button[^>]*type="button"/);
console.log("overlay control test passed");
