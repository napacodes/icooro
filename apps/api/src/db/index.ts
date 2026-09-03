import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { env } from "../env.js";
import * as schema from "./schema/index.js";

let db: ReturnType<typeof createDb> | null = null;

function createDb() {
  const pool = mysql.createPool({
    uri: env.databaseUrl,
  });

  return drizzle(pool, { schema, mode: "default" });
}

export function getDb() {
  if (!db) {
    db = createDb();
  }

  return db;
}