import { boolean, index, json, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { aiProviders } from "./ai_providers.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const aiModels = mysqlTable(
  "ai_models",
  {
    id: idColumn(),
    providerId: varchar("provider_id", { length: 36 })
      .notNull()
      .references(() => aiProviders.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    modelId: varchar("model_id", { length: 255 }).notNull(),
    capability: varchar("capability", { length: 100 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    metadata: json("metadata"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("ai_models_provider_model_unique").on(
      table.providerId,
      table.modelId,
    ),
    index("ai_models_provider_id_idx").on(table.providerId),
    index("ai_models_capability_idx").on(table.capability),
    index("ai_models_enabled_idx").on(table.enabled),
  ],
);