/**
 * Znaki z tabliczką „nie dotyczy komunikacji miejskiej / ZDKiUM”.
 *
 * OpenStreetMap rzadko zapisuje tabliczki dodatkowe, dlatego tutaj można ręcznie
 * dopisać obiekty, o których wiadomo, że mają taki dopisek. Klucz to identyfikator
 * OSM w formacie `way-123456` / `node-123456` (widoczny w linku „Zobacz obiekt
 * w OpenStreetMap” przy ograniczeniu na liście).
 *
 * Wyjątek dotyczy WYŁĄCZNIE ograniczeń wynikających z oznakowania (np. limit
 * masy, zakaz wjazdu). Nie zmienia fizycznego prześwitu wiaduktu.
 */
export const MANUAL_TRANSIT_EXEMPT_IDS: ReadonlySet<string> = new Set<string>([
  // "way-123456789",
]);

/** Tekst dopisku pokazywany w aplikacji. */
export const TRANSIT_EXEMPT_LABEL = "Nie dotyczy komunikacji miejskiej / ZDKiUM";
