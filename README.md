# Mapa Wałbrzycha — autobusy na żywo, przystanki i planer

Next.js (App Router) + Drizzle ORM + PostgreSQL app for live bus positions, stops,
timetables and a trip planner for Wałbrzych (MZUK / ŚKA).

## The `DATABASE_URL is required` build failure

**Symptom**

```
Collecting page data using 3 workers ...
Error: Failed to collect configuration for /api/traveler/last-trip
  [cause]: Error: DATABASE_URL is required
      at <unknown> (src/db/index.ts:7:9)
Error: Failed to collect page data for /api/traveler/last-trip
Error: process completed with exit code 1.
```

**Root cause**

`src/db/index.ts` threw at **module scope** when `DATABASE_URL` was missing:

```ts
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required"); // ← throws on import
}
export const db = drizzle(pool); // ← pool built from it
```

During `next build`, the *Collecting page data* phase imports every route handler
module to read its route segment config. Importing `src/app/api/traveler/*` pulled
in `@/db`, so the build process itself raised the error — even though the route
handler is never executed at build time. Any environment without `DATABASE_URL`
(CI, Docker image build, GitHub Pages export) could never build.

**Fix (in `src/db/index.ts`)**

The module is now side-effect free and the connection is created lazily:

- `getDatabaseUrl()` / `isDatabaseConfigured()` read and normalise the variable
  without throwing.
- `getPool()` creates (and memoises on `globalThis`) the `pg` pool **on the first
  query**, throwing a typed `DatabaseConfigError` only if there is no config.
- `db` is a lazy `Proxy` around the Drizzle instance, so every existing
  `db.select()`, `db.insert()`, `db.execute()` call site works unchanged while the
  import stays safe for build-time evaluation.
- Route handlers are declared `export const dynamic = "force-dynamic"`, so Next
  never attempts to prerender them during the build.

**Runtime degradation**

A server deployed without `DATABASE_URL` still serves the map, planner and live
data. Only persistence is disabled: the `/api/traveler/*` routes return a clear
`503` (see `src/lib/server/dbAvailability.ts`) instead of an opaque `500`, and
`/api/health` reports `{"ok":true,"database":"unconfigured"}`.

## Setup

```bash
npm install
cp .env.example .env       # then edit DATABASE_URL
npx drizzle-kit push       # create traveler_saved_places + traveler_trip_state
npm run dev
```

## Scripts

| Script             | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `npm run dev`      | Development server                         |
| `npm run build`    | Production build (no database required)     |
| `npm run start`    | Serve the production build                  |
| `npm run typecheck`| `tsc --noEmit`                             |
| `npm run lint`     | ESLint                                     |

## Database schema

Defined in `src/db/schema.ts`, applied with `npx drizzle-kit push`:

- `traveler_saved_places` — up to 20 saved points per client (`client_id`,
  `label`, `lat`, `lon`, `stop_id`).
- `traveler_trip_state` — one row per client holding the last origin/destination
  pair shown by the trip planner.
