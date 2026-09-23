import { boolean, index, json, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const aiProviders = mysqlTable(
  "ai_providers",
  {
    id: idColumn(),
    name: varchar("name", { length: 255 }).notNull(),
    providerType: varchar("provider_type", { length: 100 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Provider API base URL, e.g. "https://api.chatfire.site".
     * Nullable: adapters fall back to their own protocol default
     * (and CHATFIRE_BASE_URL for the chatfire adapter) when unset.
     */
    baseUrl: varchar("base_url", { length: 500 }),
    /**
     * Sealed (authenticated-encrypted) provider API key envelope.
     * Never returned by any API response; see src/providers/secrets.ts.
     */
    apiKeySecret: text("api_key_secret"),
    /**
     * Additional non-secret adapter options (timeouts, headers, ...).
     * Credential-like keys are stripped by ProviderRegistry.sanitizeProvider.
     */
    config: json("config"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("ai_providers_provider_type_idx").on(table.providerType),
    index("ai_providers_enabled_idx").on(table.enabled),
  ],
);