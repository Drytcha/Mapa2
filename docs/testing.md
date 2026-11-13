# Regression Checks

- `npx tsc --noEmit`: application type check.
- `npx vitest run`: pedestrian routing, connection feasibility and departure grouping.
- `npx playwright install --with-deps chromium`: browser-test prerequisites.
- `npx playwright test`: compact timetable (desktop and mobile), full walking geometry,
  click-to-move destination, dragging and Escape cancellation.
- `npm run build`: production build.

The browser tests use a deterministic GTFS fixture and mocked pedestrian routes.
They do not assert that the fixture's departure times are a current real timetable.
The actual pedestrian provider must also be reachable from a deployed application;
see `walking-routing.md` for configuration and public-service limits.