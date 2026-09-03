import { index, int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { episodes } from "./episodes.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const scenes = mysqlTable(
  "scenes",
  {
    id: idColumn(),
    episodeId: varchar("episode_id", { length: 36 })
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    orderIndex: int("order_index").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("scenes_episode_id_idx").on(table.episodeId),
  ],
);