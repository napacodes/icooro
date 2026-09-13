import { index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { shots } from "./shots.js";
import { assets } from "./assets.js";
import { createdAtColumn, idColumn } from "./helpers.js";

export const shotAssets = mysqlTable(
  "shot_assets",
  {
    id: idColumn(),
    shotId: varchar("shot_id", { length: 36 })
      .notNull()
      .references(() => shots.id, { onDelete: "cascade" }),
    assetId: varchar("asset_id", { length: 36 })
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    assetRole: varchar("asset_role", { length: 50 }).notNull().default("reference"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("shot_assets_pair_unique").on(table.shotId, table.assetId),
    index("shot_assets_shot_id_idx").on(table.shotId),
    index("shot_assets_asset_id_idx").on(table.assetId),
    index("shot_assets_asset_role_idx").on(table.assetRole),
  ],
);
