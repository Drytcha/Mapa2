# MapPlaner · Wałbrzych

An interactive transit map for Wałbrzych, with stops, timetables, live vehicle positions, journey planning, and planner tools. The application supports a full Next.js server and a separate static GitHub Pages deployment.

## Build

Use Node.js 22 and the committed lockfile. From the repository root:

```sh
npm ci
npx next typegen
npm exec tsc -- --noEmit --pretty false
npm run build
```

**No database or `DATABASE_URL` is needed to build.** Next.js imports API modules while collecting page data. The Drizzle client in `src/db/index.ts` now reads the private connection URL and creates one shared PostgreSQL pool only when a request actually uses the database. The no-build-cache and telemetry messages are informational.

### Dependencies and CI

`package-lock.json` is part of the repository — commit it. CI installs with `npm ci`, which is reproducible and fails loudly when `package.json` and the lockfile disagree. The workflow checks for the lockfile **before** `actions/setup-node@v4`, because that action's `cache: npm` setting exits with `Dependencies lock file is not found` when no lockfile is present. Until the lockfile is committed, CI resolves one from `package.json`, installs it, and continues with a warning. Do not silence that warning by adding the lockfile to `.gitignore`.

The `[DEP0040] DeprecationWarning: The 'punycode' module is deprecated` line in the Node.js setup step is printed by npm itself and is harmless.

## Full-stack deployment

1. Provision PostgreSQL and set `DATABASE_URL` in the server's private environment (or in an uncommitted `.env` for local use). See `.env.example`. Never use a `NEXT_PUBLIC_` prefix for database credentials.
2. For a new database, run `npx drizzle-kit push` to create the existing traveler tables. For an existing production database, review your normal migration process first.
3. Build with `npm run build`, then serve with `npm start` on a Node.js-capable host. For development, use `npm run dev`.

`GET /api/health` checks PostgreSQL with an actual query and returns HTTP 503 if the database is unavailable. The traveler APIs persist the last trip and saved places in PostgreSQL. Send the app-generated `x-client-id` header; its random value separates each browser's data. Transit server routes proxy the upstream feeds.

## GitHub Pages

GitHub Pages serves files; it cannot run PostgreSQL queries, API handlers, or a Next.js server. The included `.github/workflows/deploy.yml` therefore:

- verifies the normal server build with an empty `DATABASE_URL`;
- obtains the site's base path from `actions/configure-pages`;
- builds a frontend-only static export with the correct asset paths;
- uploads **`out/`**, not `dist/` or `.next/`.

In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**. Push to `main` or manually run the workflow. No PostgreSQL secret is needed for Pages.

To verify a project-site export locally:

```sh
NEXT_PUBLIC_STATIC_EXPORT=1 NEXT_PUBLIC_BASE_PATH=/Mapa2 DATABASE_URL= npm run build
```

Serve `out/` under `/Mapa2/`, or omit `NEXT_PUBLIC_BASE_PATH` for a root deployment. The export includes the `.tsx` UI routes but not the server's `route.ts` handlers. Leave `NEXT_PUBLIC_STATIC_EXPORT` unset for full-stack deployments.

In the static version, saved places and the last trip are stored **only in the current browser**; clearing site data removes them. Live positions need an available upstream service. The bundled Wałbrzych timetable and operator roster support schedule lookup without a database, and browser-compatible feeds handle refreshes. The full-stack build retains all six API routes.

## Transit data

The bundled `public/data/walbrzych-gtfs.zip` is the official [Wałbrzych GTFS archive](https://gtfs.walbrzych.eu/GTFS/ST/GTFS%20(full).zip), version `387_388`, obtained through the application's existing transit feed route. It matches the bundled operator snapshot and contains 5,562 trips with duty identifiers. Its service period is 7 November–31 December 2026; consult `feed_info.txt` and the service calendar, and refresh or replace the snapshot when it expires. The static build can refresh schedules from the existing Zbiorkom mirror. Map attribution is displayed in the map interface; the embedded PDF font license is in `public/licenses/`.
