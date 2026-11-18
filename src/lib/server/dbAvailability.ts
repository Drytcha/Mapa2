import { isDatabaseConfigured } from "@/db";

/**
 * Traveler storage (saved places / last trip) persists to PostgreSQL. When the
 * server is deployed without `DATABASE_URL`, the rest of the app still works —
 * only persistence is degraded — so callers get a clear 503 instead of a
 * confusing 500 caused by a missing config.
 */
export function databaseUnavailableResponse() {
  return Response.json(
    {
      error:
        "Magazyn danych podróżnego jest wyłączony: serwer nie ma skonfigurowanej bazy danych (DATABASE_URL).",
    },
    { status: 503 },
  );
}

/** True when the request should short-circuit with `databaseUnavailableResponse()`. */
export function isDatabaseUnavailable(): boolean {
  return !isDatabaseConfigured();
}
