import { index, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { projects } from "./projects.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const episodes = mysqlTable(
  "episodes",
  {
    id: idColumn(),
    projectId: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    episodeNumber: int("episode_number").notNull(),
    status: varchar("status", { length: 50 }).notNull().default("draft"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("episodes_project_number_unique").on(
      table.projectId,
      table.episodeNumber,
    ),
    index("episodes_project_id_idx").on(table.projectId),
  ],
);