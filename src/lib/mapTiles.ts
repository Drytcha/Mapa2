import L from "leaflet";

/**
 * Ciemny wariant mapy bazowej. Wcześniej ten sam efekt dawał filtr CSS na
 * każdym kaflu (`filter: invert(...)` + `mix-blend-mode` z Leafleta). Filtr i
 * mieszanie na kilkudziesięciu kaflach to kilkadziesiąt dodatkowych powierzchni
 * do złożenia w każdej klatce — przy przesuwaniu mapy potrafi to zrzucić stronę
 * do kilku klatek na sekundę. Tutaj efekt jest liczony **raz**, przy wczytaniu
 * kafla, a na ekran trafia zwykła kanwa (bez filtra, bez blendowania).
 */
export const DARK_TILE_FILTER =
  "invert(0.86) hue-rotate(180deg) brightness(1.38) contrast(0.98) saturate(0.86)";

const supportsCanvasFilter = () => {
  const context = document.createElement("canvas").getContext("2d");
  return Boolean(context && typeof context.filter === "string");
};

class TintedTileLayer extends L.TileLayer {
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const size = this.getTileSize();
    const tile = document.createElement("canvas");
    tile.width = size.x;
    tile.height = size.y;

    const context = tile.getContext("2d");
    const tintInCanvas = Boolean(context) && supportsCanvasFilter();
    if (context && !tintInCanvas) {
      // Starsze przeglądarki bez `ctx.filter` dostają filtr tylko na kaflu.
      tile.style.filter = DARK_TILE_FILTER;
    }

    const image = new Image();
    image.crossOrigin = "";
    image.decoding = "async";
    image.onload = () => {
      if (context) {
        if (tintInCanvas) context.filter = DARK_TILE_FILTER;
        context.drawImage(image, 0, 0, size.x, size.y);
        if (tintInCanvas) context.filter = "none";
      }
      done(undefined, tile);
    };
    image.onerror = () => done(new Error("tile load error"), tile);
    image.src = this.getTileUrl(coords);
    return tile;
  }
}

/** Kafle OSM przyciemnione do motywu „dark” — bez filtra CSS na warstwie. */
export const createDarkTileLayer = (
  url: string,
  options: L.TileLayerOptions,
): L.TileLayer => new TintedTileLayer(url, options);
