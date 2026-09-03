import { randomUUID } from "node:crypto";
import { datetime, varchar } from "drizzle-orm/mysql-core";

export function idColumn() {
  return varchar("id", { length: 36 })
    .primaryKey()
    .$defaultFn(() => randomUUID());
}

export function createdAtColumn() {
  return datetime("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date());
}

export function updatedAtColumn() {
  return datetime("updated_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());
}