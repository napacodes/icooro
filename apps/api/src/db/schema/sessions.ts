import { datetime, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { users } from "./users.js";
import { createdAtColumn, idColumn } from "./helpers.js";

export const sessions = mysqlTable(
  "sessions",
  {
    id: idColumn(),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);
