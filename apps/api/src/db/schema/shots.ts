import { index, int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { scenes } from "./scenes.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const shots = mysqlTable(
  "shots",
  {
    id: idColumn(),
    sceneId: varchar("scene_id", { length: 36 })
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    orderIndex: int("order_index").notNull(),
    prompt: text("prompt"),
    duration: int("duration"),
    status: varchar("status", { length: 50 }).notNull().default("pending"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("shots_scene_id_idx").on(table.sceneId),
    index("shots_status_idx").on(table.status),
  ],
);