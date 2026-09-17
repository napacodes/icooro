import { mysqlTable, text, varchar, index } from "drizzle-orm/mysql-core";
import { users } from "./users.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const projects = mysqlTable(
  "projects",
  {
    id: idColumn(),
    ownerId: varchar("owner_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 50 }).notNull().default("draft"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index("projects_owner_id_idx").on(table.ownerId)],
);
