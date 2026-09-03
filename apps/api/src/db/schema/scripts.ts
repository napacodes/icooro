import { index, int, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { episodes } from "./episodes.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const scripts = mysqlTable(
  "scripts",
  {
    id: idColumn(),
    episodeId: varchar("episode_id", { length: 36 })
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    version: int("version").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("scripts_episode_version_unique").on(
      table.episodeId,
      table.version,
    ),
    index("scripts_episode_id_idx").on(table.episodeId),
  ],
);