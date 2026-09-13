import { index, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { projects } from "./projects.js";
import { assets } from "./assets.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const props = mysqlTable(
  "props",
  {
    id: idColumn(),
    projectId: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    visualDescription: text("visual_description"),
    referenceAssetId: varchar("reference_asset_id", { length: 36 }).references(
      (): any => assets.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("props_project_id_idx").on(table.projectId),
    index("props_reference_asset_id_idx").on(table.referenceAssetId),
  ],
);