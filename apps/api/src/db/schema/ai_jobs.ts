import { index, int, json, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { aiProviders } from "./ai_providers.js";
import { aiModels } from "./ai_models.js";
import { projects } from "./projects.js";
import { episodes } from "./episodes.js";
import { scenes } from "./scenes.js";
import { shots } from "./shots.js";
import { shotVersions } from "./shot_versions.js";
import { assets } from "./assets.js";
import { assetVersions } from "./asset_versions.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const aiJobs = mysqlTable(
  "ai_jobs",
  {
    id: idColumn(),
    jobType: varchar("job_type", { length: 100 }).notNull(),
    status: varchar("status", { length: 50 }).notNull().default("queued"),
    providerId: varchar("provider_id", { length: 36 }).references(
      () => aiProviders.id,
      { onDelete: "set null" },
    ),
    modelId: varchar("model_id", { length: 36 }).references(() => aiModels.id, {
      onDelete: "set null",
    }),
    externalJobId: varchar("external_job_id", { length: 255 }),
    projectId: varchar("project_id", { length: 36 }).references(
      () => projects.id,
      { onDelete: "cascade" },
    ),
    episodeId: varchar("episode_id", { length: 36 }).references(
      () => episodes.id,
      { onDelete: "cascade" },
    ),
    sceneId: varchar("scene_id", { length: 36 }).references(() => scenes.id, {
      onDelete: "cascade",
    }),
    shotId: varchar("shot_id", { length: 36 }).references(() => shots.id, {
      onDelete: "cascade",
    }),
    shotVersionId: varchar("shot_version_id", { length: 36 }).references(
      () => shotVersions.id,
      { onDelete: "cascade" },
    ),
    assetId: varchar("asset_id", { length: 36 }).references(() => assets.id, {
      onDelete: "set null",
    }),
    assetVersionId: varchar("asset_version_id", { length: 36 }).references(
      (): any => assetVersions.id,
      { onDelete: "set null" },
    ),
    prompt: text("prompt"),
    negativePrompt: text("negative_prompt"),
    targetMediaType: varchar("target_media_type", { length: 50 }),
    requestedDuration: int("requested_duration"),
    requestedWidth: int("requested_width"),
    requestedHeight: int("requested_height"),
    progress: int("progress").notNull().default(0),
    error: text("error"),
    metadata: json("metadata"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("ai_jobs_external_job_id_unique").on(table.externalJobId),
    index("ai_jobs_status_idx").on(table.status),
    index("ai_jobs_job_type_idx").on(table.jobType),
    index("ai_jobs_provider_id_idx").on(table.providerId),
    index("ai_jobs_model_id_idx").on(table.modelId),
    index("ai_jobs_project_id_idx").on(table.projectId),
    index("ai_jobs_episode_id_idx").on(table.episodeId),
    index("ai_jobs_scene_id_idx").on(table.sceneId),
    index("ai_jobs_shot_id_idx").on(table.shotId),
    index("ai_jobs_shot_version_id_idx").on(table.shotVersionId),
    index("ai_jobs_asset_id_idx").on(table.assetId),
    index("ai_jobs_asset_version_id_idx").on(table.assetVersionId),
  ],
);