import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { APP_SERVICE_API } from "@icooro/shared";
import { env } from "./env.js";
import { getDb } from "./db/index.js";
import { projectsRoute } from "./routes/projects.js";
import {
  episodesRoute,
  scriptsRoute,
  charactersRoute,
  locationsRoute,
  propsRoute,
  scenesRoute,
  shotsRoute,
  shotCharactersRoute,
  shotLocationsRoute,
  shotPropsRoute,
  shotVersionsRoute,
  nestedStorytellingRoute,
} from "./routes/storytelling.js";

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

app.route("/api/v1/projects", projectsRoute);
app.route("/api/v1/episodes", episodesRoute);
app.route("/api/v1/scripts", scriptsRoute);
app.route("/api/v1/characters", charactersRoute);
app.route("/api/v1/locations", locationsRoute);
app.route("/api/v1/props", propsRoute);
app.route("/api/v1/scenes", scenesRoute);
app.route("/api/v1/shots", shotsRoute);
app.route("/api/v1/shot-characters", shotCharactersRoute);
app.route("/api/v1/shot-locations", shotLocationsRoute);
app.route("/api/v1/shot-props", shotPropsRoute);
app.route("/api/v1/shot-versions", shotVersionsRoute);
app.route("/api/v1", nestedStorytellingRoute);

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