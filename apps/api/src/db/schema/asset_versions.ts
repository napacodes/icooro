import {
  bigint,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { assets } from "./assets.js";
import { aiJobs } from "./ai_jobs.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const assetVersions = mysqlTable(
  "asset_versions",
  {
    id: idColumn(),
    assetId: varchar("asset_id", { length: 36 })
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    version: int("version").notNull(),
    status: varchar("status", { length: 50 }).notNull().default("ready"),
    sourceKind: varchar("source_kind", { length: 50 }).notNull().default("upload"),
    storageKey: varchar("storage_key", { length: 1024 }).notNull(),
    fileExtension: varchar("file_extension", { length: 20 }),
    mimeType: varchar("mime_type", { length: 255 }),
    fileSize: bigint("file_size", { mode: "number" }),
    checksum: varchar("checksum", { length: 128 }),
    width: int("width"),
    height: int("height"),
    duration: int("duration"),
    fps: int("fps"),
    sampleRate: int("sample_rate"),
    channels: int("channels"),
    codec: varchar("codec", { length: 100 }),
    prompt: text("prompt"),
    negativePrompt: text("negative_prompt"),
    jobId: varchar("job_id", { length: 36 }).references((): any => aiJobs.id, {
      onDelete: "set null",
    }),
    metadata: json("metadata"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("asset_versions_asset_version_unique").on(
      table.assetId,
      table.version,
    ),
    index("asset_versions_asset_id_idx").on(table.assetId),
    index("asset_versions_status_idx").on(table.status),
    index("asset_versions_source_kind_idx").on(table.sourceKind),
    index("asset_versions_job_id_idx").on(table.jobId),
  ],
);
