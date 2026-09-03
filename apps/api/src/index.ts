import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { APP_SERVICE_API } from "@icooro/shared";
import { env } from "./env.js";
import { getDb } from "./db/index.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://localhost:3000"],
  }),
);

app.get("/health", (c) => {
  return c.json({
    ok: true,
    service: APP_SERVICE_API,
  });
});

app.get("/api/v1/health/db", async (c) => {
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

serve(
  {
    fetch: app.fetch,
    port: env.port,
    hostname: "0.0.0.0",
  },
  (info) => {
    console.log(`${APP_SERVICE_API} listening on ${info.address}:${info.port}`);
  },
);