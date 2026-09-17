import { mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const users = mysqlTable(
  "users",
  {
    id: idColumn(),
    email: varchar("email", { length: 254 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    passwordHash: varchar("password_hash", { length: 512 }).notNull(),
    role: varchar("role", { length: 20 }).notNull().default("user"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
  ],
);
