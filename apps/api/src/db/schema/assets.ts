import {
  index,
  int,
  json,
  mysqlTable,
  varchar,
} from "drizzle-orm/mysql-core";
import { projects } from "./projects.js";
import { episodes } from "./episodes.js";
import { shots } from "./shots.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const assets = mysqlTable(
  "assets",
  {
    id: idColumn(),
    projectId: varchar("project_id", { length: 36 }).references(
      () => projects.id,
      { onDelete: "cascade" },
    ),
    episodeId: varchar("episode_id", { length: 36 }).references(
      () => episodes.id,
      { onDelete: "cascade" },
    ),
    shotId: varchar("shot_id", { length: 36 }).references(() => shots.id, {
      onDelete: "cascade",
    }),
    type: varchar("type", { length: 50 }).notNull(),
    storageKey: varchar("storage_key", { length: 1024 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }),
    fileSize: int("file_size"),
    width: int("width"),
    height: int("height"),
    duration: int("duration"),
    metadata: json("metadata"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("assets_project_id_idx").on(table.projectId),
    index("assets_episode_id_idx").on(table.episodeId),
    index("assets_shot_id_idx").on(table.shotId),
    index("assets_type_idx").on(table.type),
  ],
);