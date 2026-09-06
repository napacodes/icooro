import { index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { shots } from "./shots.js";
import { locations } from "./locations.js";
import { createdAtColumn, idColumn } from "./helpers.js";

export const shotLocations = mysqlTable(
  "shot_locations",
  {
    id: idColumn(),
    shotId: varchar("shot_id", { length: 36 })
      .notNull()
      .references(() => shots.id, { onDelete: "cascade" }),
    locationId: varchar("location_id", { length: 36 })
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("shot_locations_pair_unique").on(table.shotId, table.locationId),
    index("shot_locations_shot_id_idx").on(table.shotId),
    index("shot_locations_location_id_idx").on(table.locationId),
  ],
);
