import { index, int, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { shots } from "./shots.js";
import { aiProviders } from "./ai_providers.js";
import { aiModels } from "./ai_models.js";
import { assets } from "./assets.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const shotVersions = mysqlTable(
  "shot_versions",
  {
    id: idColumn(),
    shotId: varchar("shot_id", { length: 36 })
      .notNull()
      .references(() => shots.id, { onDelete: "cascade" }),
    version: int("version").notNull(),
    prompt: text("prompt"),
    status: varchar("status", { length: 50 }).notNull().default("pending"),
    providerId: varchar("provider_id", { length: 36 }).references(
      () => aiProviders.id,
      { onDelete: "set null" },
    ),
    modelId: varchar("model_id", { length: 36 }).references(() => aiModels.id, {
      onDelete: "set null",
    }),
    assetId: varchar("asset_id", { length: 36 }).references(() => assets.id, {
      onDelete: "set null",
    }),
    duration: int("duration"),
    error: text("error"),
    productionReady: int("production_ready").notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("shot_versions_shot_version_unique").on(
      table.shotId,
      table.version,
    ),
    index("shot_versions_shot_id_idx").on(table.shotId),
    index("shot_versions_status_idx").on(table.status),
    index("shot_versions_provider_id_idx").on(table.providerId),
    index("shot_versions_model_id_idx").on(table.modelId),
    index("shot_versions_asset_id_idx").on(table.assetId),
  ],
);