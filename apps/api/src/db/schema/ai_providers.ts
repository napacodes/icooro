import { boolean, index, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const aiProviders = mysqlTable(
  "ai_providers",
  {
    id: idColumn(),
    name: varchar("name", { length: 255 }).notNull(),
    providerType: varchar("provider_type", { length: 100 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: json("config"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("ai_providers_provider_type_idx").on(table.providerType),
    index("ai_providers_enabled_idx").on(table.enabled),
  ],
);