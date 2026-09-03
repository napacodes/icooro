import { mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

export const projects = mysqlTable("projects", {
  id: idColumn(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 50 }).notNull().default("draft"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});