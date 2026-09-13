import {
  index,
  int,
  json,
  mysqlTable,
  text,
  varchar,
} from "drizzle-orm/mysql-core";
import { projects } from "./projects.js";
import { episodes } from "./episodes.js";
import { scenes } from "./scenes.js";
import { shots } from "./shots.js";
import { characters } from "./characters.js";
import { locations } from "./locations.js";
import { props } from "./props.js";
import { assetVersions } from "./asset_versions.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const assets = mysqlTable(
  "assets",
  {
    id: idColumn(),
    projectId: varchar("project_id", { length: 36 }).references(
      () => projects.id,
      { onDelete: "cascade" },
    ),
    name: varchar("name", { length: 255 }).notNull().default(""),
    description: text("description"),
    status: varchar("status", { length: 50 }).notNull().default("draft"),
    type: varchar("type", { length: 50 }).notNull(),
    approvedVersionId: varchar("approved_version_id", { length: 36 }).references(
      (): any => assetVersions.id,
      { onDelete: "set null" },
    ),
    episodeId: varchar("episode_id", { length: 36 }).references(
      () => episodes.id,
      { onDelete: "cascade" },
    ),
    sceneId: varchar("scene_id", { length: 36 }).references(
      () => scenes.id,
      { onDelete: "cascade" },
    ),
    shotId: varchar("shot_id", { length: 36 }).references(() => shots.id, {
      onDelete: "cascade",
    }),
    characterId: varchar("character_id", { length: 36 }).references(
      (): any => characters.id,
      { onDelete: "set null" },
    ),
    locationId: varchar("location_id", { length: 36 }).references(
      (): any => locations.id,
      { onDelete: "set null" },
    ),
    propId: varchar("prop_id", { length: 36 }).references(
      (): any => props.id,
      { onDelete: "set null" },
    ),
    storageKey: varchar("storage_key", { length: 1024 }),
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
    index("assets_scene_id_idx").on(table.sceneId),
    index("assets_shot_id_idx").on(table.shotId),
    index("assets_character_id_idx").on(table.characterId),
    index("assets_location_id_idx").on(table.locationId),
    index("assets_prop_id_idx").on(table.propId),
    index("assets_type_idx").on(table.type),
    index("assets_status_idx").on(table.status),
    index("assets_approved_version_id_idx").on(table.approvedVersionId),
  ],
);