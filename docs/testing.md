# Regression Checks

- `npx tsc --noEmit`: application type check.
- `npx vitest run`: pedestrian routing, connection feasibility, nearest-boarding-stop priority,
  unconfirmed-footpath handling and departure grouping. The timetable tests also cover a
  dominant main direction without a letter, deviations with stable letters, and ambiguous
  samples where every direction keeps a letter.
- `npx playwright install --with-deps chromium`: browser-test prerequisites.
- `npx playwright test`: compact timetable (desktop and mobile), full walking geometry,
  click-to-move destination, dragging and Escape cancellation.
- `npm run build`: production build.

The browser tests use a deterministic GTFS fixture and mocked pedestrian routes.
They do not assert that the fixture's departure times are a current real timetable.
The actual pedestrian provider must also be reachable from a deployed application;
see `walking-routing.md` for configuration and public-service limits.
The compact timetable test also checks that the layout stays within a 390 px mobile viewport
and that a dominant direction has an accessible "Kierunek główny" label while deviations keep letters.

Brigade metrics (`tests/brigadeMetrics.test.ts`) cover duty duration, driving vs layover
minutes, vehicle-kilometres, revenue/technical/depot splits, missing lengths and honest
behaviour when the GTFS feed contains only passenger trips. The browser suite also checks
that the planner sees the kilometre breakdown in the kursówki view.
