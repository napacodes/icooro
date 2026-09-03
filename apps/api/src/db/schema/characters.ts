import { index, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { projects } from "./projects.js";
import { assets } from "./assets.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const characters = mysqlTable(
  "characters",
  {
    id: idColumn(),
    projectId: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    visualDescription: text("visual_description"),
    referenceAssetId: varchar("reference_asset_id", { length: 36 }).references(
      () => assets.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("characters_project_id_idx").on(table.projectId),
    index("characters_reference_asset_id_idx").on(table.referenceAssetId),
  ],
);