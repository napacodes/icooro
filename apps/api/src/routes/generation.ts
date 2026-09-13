import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { aiProviders } from "../db/schema/ai_providers.js";
import { aiModels } from "../db/schema/ai_models.js";
import { generationJobService } from "../services/generation.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  createGenerationJobSchema,
  formatZodError,
} from "../validation/schemas.js";

type Status = 400 | 404 | 409 | 500;
const bad = (
  message: string,
  status: Status = 400,
  code = status === 404
    ? "NOT_FOUND"
    : status === 409
      ? "CONFLICT"
      : "INVALID_REQUEST",
) => ({ error: { code, message } });

const internal = () =>
  bad("An unexpected error occurred", 500, "INTERNAL_ERROR");

async function parseJsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export const generationJobsRoute = new Hono();
generationJobsRoute.onError((error) => {
  console.error("Unhandled generationJobsRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

export const nestedGenerationJobsRoute = new Hono();
nestedGenerationJobsRoute.onError((error) => {
  console.error("Unhandled nestedGenerationJobsRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

export const aiProvidersRoute = new Hono();
export const aiModelsRoute = new Hono();

nestedGenerationJobsRoute.get("/projects/:projectId/jobs", async (c) => {
  const projectId = c.req.param("projectId");
  try {
    const jobs = await generationJobService.listProjectJobs(projectId);
    return c.json({ data: jobs });
  } catch (error) {
    console.error("Failed to list project jobs", error);
    return c.json(internal(), 500);
  }
});

nestedGenerationJobsRoute.post("/projects/:projectId/jobs", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }

  const parsed = createGenerationJobSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const created = await generationJobService.createJob({
      projectId,
      ...parsed.data,
    });
    return c.json({ data: created }, 201);
  } catch (error: any) {
    if (
      error.message === "Project not found" ||
      error.message === "Episode not found" ||
      error.message === "Scene not found" ||
      error.message === "Shot not found" ||
      error.message === "Referenced asset not found" ||
      error.message === "AI Provider not found" ||
      error.message === "AI Model not found"
    ) {
      return c.json(bad(error.message, 404), 404);
    }
    if (error.message.includes("does not belong")) {
      return c.json(bad(error.message, 400), 400);
    }
    console.error("Failed to create generation job", error);
    return c.json(internal(), 500);
  }
});

generationJobsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const job = await generationJobService.getJob(id);
    if (!job) {
      return c.json(bad("Job not found", 404), 404);
    }
    return c.json({ data: job });
  } catch (error) {
    console.error("Failed to get job", error);
    return c.json(internal(), 500);
  }
});

generationJobsRoute.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  try {
    const cancelled = await generationJobService.cancelJob(id);
    return c.json({ data: cancelled });
  } catch (error: any) {
    if (error.message === "Job not found") {
      return c.json(bad(error.message, 404), 404);
    }
    if (error.message.includes("Cannot cancel job")) {
      return c.json(bad(error.message, 400), 400);
    }
    console.error("Failed to cancel job", error);
    return c.json(internal(), 500);
  }
});

// --- AI Providers and Models Routes ---

aiProvidersRoute.get("/", async (c) => {
  try {
    const rows = await getDb().select().from(aiProviders);
    // Credentials stripped before returning!
    const sanitized = rows.map((row) => ProviderRegistry.sanitizeProvider(row));
    return c.json({ data: sanitized });
  } catch (error) {
    console.error("Failed to list AI providers", error);
    return c.json(internal(), 500);
  }
});

aiProvidersRoute.get("/:id", async (c) => {
  try {
    const [row] = await getDb()
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, c.req.param("id")));
    if (!row) {
      return c.json(bad("Provider not found", 404), 404);
    }
    return c.json({ data: ProviderRegistry.sanitizeProvider(row) });
  } catch (error) {
    console.error("Failed to get AI provider", error);
    return c.json(internal(), 500);
  }
});

aiModelsRoute.get("/", async (c) => {
  try {
    const providerId = c.req.query("providerId");
    const rows = providerId
      ? await getDb()
          .select()
          .from(aiModels)
          .where(eq(aiModels.providerId, providerId))
      : await getDb().select().from(aiModels);
    return c.json({ data: rows });
  } catch (error) {
    console.error("Failed to list AI models", error);
    return c.json(internal(), 500);
  }
});
