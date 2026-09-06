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
    purpose: varchar("purpose", { length: 100 }),
    shotType: varchar("shot_type", { length: 100 }),
    framing: varchar("framing", { length: 100 }),
    cameraMovement: varchar("camera_movement", { length: 100 }),
    cameraAngle: varchar("camera_angle", { length: 100 }),
    prompt: text("prompt"),
    visualDescription: text("visual_description"),
    actionDescription: text("action_description"),
    dialogue: text("dialogue"),
    transition: varchar("transition", { length: 100 }),
    productionNotes: text("production_notes"),
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