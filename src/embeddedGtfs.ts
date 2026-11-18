/**
 * Wbudowana, oficjalna paczka GTFS Wałbrzycha — wariant "GTFS (full).zip".
 *
 * Wariant publiczny (`GTFS/ST/GTFS.zip`) NIE zawiera linii 30 (brygady 30/01 i 30/02
 * od 1 grudnia) ani linii planistycznych S1–S4. Dlatego do aplikacji trafia
 * wyłącznie paczka "full".
 *
 * Aplikacja zawsze prosi o `data/walbrzych-gtfs.zip`. Ten moduł podmienia to
 * żądanie na paczkę zapakowaną w bundle, więc działa to także wtedy, gdy serwowany
 * jest sam plik index.html (bez katalogu `data/`).
 */
import embeddedGtfsUrl from "./assets/walbrzych-gtfs.zip?url";

const GTFS_REQUEST = /(^|\/)data\/walbrzych-gtfs\.zip(\?|#|$)/;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function installEmbeddedGtfs(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    GTFS_REQUEST.test(requestUrl(input))
      ? nativeFetch(embeddedGtfsUrl)
      : nativeFetch(input, init);
}
