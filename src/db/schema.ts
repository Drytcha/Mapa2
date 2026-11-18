import {
  doublePrecision,
  index,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const travelerSavedPlaces = pgTable(
  "traveler_saved_places",
  {
    id: serial("id").primaryKey(),
    clientId: text("client_id").notNull(),
    label: text("label").notNull(),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    stopId: text("stop_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("traveler_saved_places_client_idx").on(table.clientId)]
);

export const travelerTripState = pgTable("traveler_trip_state", {
  clientId: text("client_id").primaryKey(),
  originLat: doublePrecision("origin_lat"),
  originLon: doublePrecision("origin_lon"),
  originLabel: text("origin_label"),
  originStopId: text("origin_stop_id"),
  destLat: doublePrecision("dest_lat"),
  destLon: doublePrecision("dest_lon"),
  destLabel: text("dest_label"),
  destStopId: text("dest_stop_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TravelerSavedPlaceRow = typeof travelerSavedPlaces.$inferSelect;
export type TravelerTripStateRow = typeof travelerTripState.$inferSelect;
