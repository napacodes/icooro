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
import {
  assetsRoute,
  assetVersionsRoute,
  nestedAssetsRoute,
} from "./routes/assets.js";
import {
  shotAssetsRoute,
  nestedShotAssetsRoute,
} from "./routes/shot_assets.js";
import {
  aiModelsRoute,
  aiProvidersRoute,
  generationJobsRoute,
  nestedGenerationJobsRoute,
} from "./routes/generation.js";
import { authRoute } from "./routes/auth.js";
import { adminRoute } from "./routes/admin.js";
import { sessionMiddleware, requireUser } from "./middleware/session.js";

export const app = new Hono();

// Browser origins that may call the API with credentials. Driven by
// `API_CORS_ORIGINS` (comma-separated); defaults to the local dev origin.
// Origins are echoed per-request, never wildcarded, so credentials stay valid.
app.use(
  "*",
  cors({
    origin: env.corsOrigins,
    credentials: true,
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

// Session resolution is global so every downstream handler can read
// `c.get("userId")`. Routes opt into authentication via `requireUser()`.
app.use("/api/v1/*", sessionMiddleware);

// Public (auth-related) routes.
app.route("/api/v1/auth", authRoute);

// Admin control plane — admin-only.
app.route("/api/v1/admin", adminRoute);

// All other /api/v1 routes require an authenticated user.
app.use(
  "/api/v1/projects",
  requireUser(),
);
app.use(
  "/api/v1/projects/*",
  requireUser(),
);

// All application routes require an authenticated user.
const requireUserApp = requireUser();
[
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
  assetsRoute,
  assetVersionsRoute,
  shotAssetsRoute,
  generationJobsRoute,
  aiModelsRoute,
  aiProvidersRoute,
].forEach((route) => {
  route.use("*", requireUserApp);
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
app.route("/api/v1/assets", assetsRoute);
app.route("/api/v1/asset-versions", assetVersionsRoute);
app.route("/api/v1/shot-assets", shotAssetsRoute);
app.route("/api/v1/jobs", generationJobsRoute);
app.route("/api/v1/ai-providers", aiProvidersRoute);
app.route("/api/v1/ai-models", aiModelsRoute);
app.route("/api/v1", nestedStorytellingRoute);
app.route("/api/v1", nestedAssetsRoute);
app.route("/api/v1", nestedShotAssetsRoute);
app.route("/api/v1", nestedGenerationJobsRoute);

// Only start the HTTP listener if this file is run directly
if (process.env.NODE_ENV !== "test" && !process.env.ICOORO_API_DISABLE_LISTENER) {
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
}