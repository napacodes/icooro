import { index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { shots } from "./shots.js";
import { props } from "./props.js";
import { createdAtColumn, idColumn } from "./helpers.js";

export const shotProps = mysqlTable(
  "shot_props",
  {
    id: idColumn(),
    shotId: varchar("shot_id", { length: 36 })
      .notNull()
      .references(() => shots.id, { onDelete: "cascade" }),
    propId: varchar("prop_id", { length: 36 })
      .notNull()
      .references(() => props.id, { onDelete: "cascade" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("shot_props_pair_unique").on(table.shotId, table.propId),
    index("shot_props_shot_id_idx").on(table.shotId),
    index("shot_props_prop_id_idx").on(table.propId),
  ],
);
