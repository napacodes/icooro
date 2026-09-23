import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users } from "../db/schema/users.js";
import { projects } from "../db/schema/projects.js";
import { aiProviders } from "../db/schema/ai_providers.js";
import { aiModels } from "../db/schema/ai_models.js";
import { aiJobs } from "../db/schema/ai_jobs.js";
import { requireAdmin, sessionMiddleware } from "../middleware/session.js";
import { providerSecretStore } from "../providers/secrets.js";
import { isAdaptableProviderType, isKnownProviderType, listProviderTypes } from "../providers/types_catalog.js";
import { toModelDto, toProviderDto } from "../providers/dto.js";
import { generationJobService } from "../services/generation.js";
import {
  adminCreateModelSchema,
  adminCreateProviderSchema,
  adminUpdateModelSchema,
  adminUpdateProviderSchema,
  adminUpdateUserSchema,
  formatZodError,
} from "../validation/schemas.js";

/**
 * Admin Control Plane API (C6.2).
 *
 * All endpoints require session authentication and the "admin" user role.
 * Sensitive credentials (passwords, tokens, API keys, provider secrets)
 * are NEVER returned.
 */
export const adminRoute = new Hono();

adminRoute.use("*", sessionMiddleware);
adminRoute.use("*", requireAdmin());

type Status = 400 | 404 | 409 | 500;
const bad = (
  message: string,
  status: Status = 400,
  code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INVALID_REQUEST",
) => ({ error: { code, message } });

const internal = () =>
  bad("An unexpected database error occurred", 500, "INTERNAL_ERROR");

async function parseJsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function sanitizeUser(u: Record<string, unknown>) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
    updatedAt: u.updatedAt instanceof Date ? u.updatedAt.toISOString() : u.updatedAt,
  };
}

async function providerNameFor(db: ReturnType<typeof getDb>, providerId: string | null | undefined) {
  if (!providerId) return null;
  const [provider] = await db.select({ name: aiProviders.name }).from(aiProviders).where(eq(aiProviders.id, providerId));
  return provider?.name ?? null;
}

function stub(section: string) {
  return (c: any) =>
    c.json({
      data: {
        section,
        status: "not_implemented",
        message:
          "This admin section is a foundation stub. Full functionality will be delivered in a later phase.",
      },
    });
}

// ---------------------------------------------------------------------------
// 0. Base / Health
// ---------------------------------------------------------------------------

adminRoute.get("/", (c) => c.json({ data: { status: "ok", surface: "admin" } }));

// ---------------------------------------------------------------------------
// 1. Admin Overview
// ---------------------------------------------------------------------------

adminRoute.get("/overview", async (c) => {
  try {
    const db = getDb();
    const userRows = await db.select().from(users);
    const projectRows = await db.select().from(projects);
    const providerRows = await db.select().from(aiProviders);
    const modelRows = await db.select().from(aiModels);
    const jobRows = await db.select().from(aiJobs);

    const jobsByStatus: Record<string, number> = {
      queued: 0,
      submitted: 0,
      processing: 0,
      downloading: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const j of jobRows) {
      const st = (j.status as string) || "queued";
      if (typeof jobsByStatus[st] === "number") {
        jobsByStatus[st] += 1;
      }
    }

    return c.json({
      data: {
        usersCount: userRows.length,
        adminUsersCount: userRows.filter((u: any) => u.role === "admin").length,
        projectsCount: projectRows.length,
        providersCount: providerRows.length,
        enabledProvidersCount: providerRows.filter((p: any) => Boolean(p.enabled)).length,
        modelsCount: modelRows.length,
        enabledModelsCount: modelRows.filter((m: any) => Boolean(m.enabled)).length,
        jobsCount: jobRows.length,
        jobsByStatus,
      },
    });
  } catch (error) {
    console.error("Failed to load admin overview", error);
    return c.json(internal(), 500);
  }
});

// ---------------------------------------------------------------------------
// 2. Users
// ---------------------------------------------------------------------------

adminRoute.get("/users", async (c) => {
  try {
    const db = getDb();
    const rows = await db.select().from(users).orderBy(desc(users.createdAt));
    return c.json({ data: rows.map(sanitizeUser) });
  } catch (error) {
    console.error("Failed to list users", error);
    return c.json(internal(), 500);
  }
});

adminRoute.get("/users/:id", async (c) => {
  try {
    const db = getDb();
    const [row] = await db.select().from(users).where(eq(users.id, c.req.param("id")));
    if (!row) {
      return c.json(bad("User not found", 404), 404);
    }
    return c.json({ data: sanitizeUser(row) });
  } catch (error) {
    console.error("Failed to get user", error);
    return c.json(internal(), 500);
  }
});

adminRoute.patch("/users/:id", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = adminUpdateUserSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const db = getDb();
    const id = c.req.param("id");
    const [existing] = await db.select().from(users).where(eq(users.id, id));
    if (!existing) {
      return c.json(bad("User not found", 404), 404);
    }

    await db
      .update(users)
      .set({
        ...parsed.data,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));

    const [updated] = await db.select().from(users).where(eq(users.id, id));
    if (!updated) {
      return c.json(internal(), 500);
    }
    return c.json({ data: sanitizeUser(updated) });
  } catch (error) {
    console.error("Failed to update user", error);
    return c.json(internal(), 500);
  }
});

// ---------------------------------------------------------------------------
// 3. Projects
// ---------------------------------------------------------------------------

adminRoute.get("/projects", async (c) => {
  try {
    const db = getDb();
    const rows = await db.select().from(projects).orderBy(desc(projects.createdAt));
    const userRows = await db.select().from(users);
    const userMap = new Map(userRows.map((u: any) => [u.id, u]));

    const data = rows.map((p: any) => {
      const owner = userMap.get(p.ownerId);
      return {
        id: p.id,
        ownerId: p.ownerId,
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.name ?? null,
        name: p.name,
        description: p.description,
        status: p.status,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
      };
    });

    return c.json({ data });
  } catch (error) {
    console.error("Failed to list projects", error);
    return c.json(internal(), 500);
  }
});

adminRoute.get("/projects/:id", async (c) => {
  try {
    const db = getDb();
    const id = c.req.param("id");
    const [p] = await db.select().from(projects).where(eq(projects.id, id));
    if (!p) {
      return c.json(bad("Project not found", 404), 404);
    }
    const [owner] = await db.select().from(users).where(eq(users.id, p.ownerId));

    return c.json({
      data: {
        id: p.id,
        ownerId: p.ownerId,
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.name ?? null,
        name: p.name,
        description: p.description,
        status: p.status,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
      },
    });
  } catch (error) {
    console.error("Failed to get project", error);
    return c.json(internal(), 500);
  }
});

adminRoute.delete("/projects/:id", async (c) => {
  try {
    const db = getDb();
    const id = c.req.param("id");
    const [existing] = await db.select().from(projects).where(eq(projects.id, id));
    if (!existing) {
      return c.json(bad("Project not found", 404), 404);
    }

    await db.delete(projects).where(eq(projects.id, id));
    return c.body(null, 204);
  } catch (error) {
    console.error("Failed to delete project", error);
    return c.json(internal(), 500);
  }
});

// ---------------------------------------------------------------------------
// 4. AI Providers (C6.3 — database-driven provider configuration)
// ---------------------------------------------------------------------------

/**
 * Provider types an admin can configure (C6.7.1). Covers the whole Icooro
 * provider architecture — openai, google_gemini, custom_openai_compatible
 * and chatfire — with an `adapterAvailable` flag marking the ones whose
 * network adapter is already implemented. The Admin UI uses this to label
 * reserved types ("adapter coming soon") instead of hiding them.
 */
adminRoute.get("/provider-types", (c) => {
  return c.json({ data: listProviderTypes() });
});

adminRoute.get("/providers", async (c) => {
  try {
    const db = getDb();
    const rows = await db.select().from(aiProviders);
    return c.json({ data: rows.map((row: any) => toProviderDto(row)) });
  } catch (error) {
    console.error("Failed to list AI providers", error);
    return c.json(internal(), 500);
  }
});

adminRoute.get("/providers/:id", async (c) => {
  try {
    const db = getDb();
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, c.req.param("id")));
    if (!row) {
      return c.json(bad("Provider not found", 404), 404);
    }
    return c.json({ data: toProviderDto(row) });
  } catch (error) {
    console.error("Failed to get AI provider", error);
    return c.json(internal(), 500);
  }
});

adminRoute.post("/providers", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = adminCreateProviderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  if (!isKnownProviderType(parsed.data.providerType)) {
    return c.json(
      bad(
        `Unknown provider type "${parsed.data.providerType}" — it is not part of the Icooro provider architecture (expected one of: openai, google_gemini, custom_openai_compatible, chatfire)`,
        400,
      ),
      400,
    );
  }

  // A reserved type (adapter not implemented yet) may be *modelled* in the
  // Control Plane, but cannot be given credentials or enabled for
  // generation. Otherwise an admin could save a working-looking provider
  // that would only fail at run time.
  if (!isAdaptableProviderType(parsed.data.providerType)) {
    return c.json(
      bad(
        `Provider type "${parsed.data.providerType}" has no adapter implementation yet — it is reserved for a later phase and cannot be configured with credentials.`,
        400,
      ),
      400,
    );
  }

  try {
    const db = getDb();

    // Duplicate (name) providers would be confusing in the Control Plane;
    // the unique constraint is at the adapter+baseUrl+key level in practice.
    const [existing] = await db
      .select({ id: aiProviders.id })
      .from(aiProviders)
      .where(eq(aiProviders.name, parsed.data.name));
    if (existing) {
      return c.json(bad("A provider with this name already exists", 409), 409);
    }

    const apiKeySecret =
      parsed.data.apiKey !== undefined && parsed.data.apiKey !== ""
        ? providerSecretStore.seal(parsed.data.apiKey)
        : null;

    const [created] = await db
      .insert(aiProviders)
      .values({
        name: parsed.data.name,
        providerType: parsed.data.providerType,
        enabled: parsed.data.enabled ?? true,
        baseUrl: parsed.data.baseUrl ?? null,
        apiKeySecret,
        config: parsed.data.config ?? null,
      })
      .$returningId();
    if (!created) {
      return c.json(internal(), 500);
    }

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, created.id));
    if (!row) {
      return c.json(internal(), 500);
    }
    return c.json({ data: toProviderDto(row) }, 201);
  } catch (error) {
    console.error("Failed to create AI provider", error);
    return c.json(internal(), 500);
  }
});

adminRoute.patch("/providers/:id", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = adminUpdateProviderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const db = getDb();
    const id = c.req.param("id");
    const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
    if (!existing) {
      return c.json(bad("Provider not found", 404), 404);
    }

    // apiKey is write-only: present means rotate, absent means keep as-is.
    const { apiKey, ...rest } = parsed.data;
    const updateValues: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (apiKey !== undefined) {
      updateValues.apiKeySecret = apiKey === "" ? null : providerSecretStore.seal(apiKey);
    }

    await db.update(aiProviders).set(updateValues).where(eq(aiProviders.id, id));

    const [updated] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
    if (!updated) {
      return c.json(internal(), 500);
    }
    return c.json({ data: toProviderDto(updated) });
  } catch (error) {
    console.error("Failed to update AI provider", error);
    return c.json(internal(), 500);
  }
});

adminRoute.delete("/providers/:id", async (c) => {
  try {
    const db = getDb();
    const id = c.req.param("id");
    const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
    if (!existing) {
      return c.json(bad("Provider not found", 404), 404);
    }

    // Safe-delete guard: models are ON DELETE CASCADE and jobs are
    // ON DELETE SET NULL, so removing a referenced provider would silently
    // destroy model configuration and strip generation provenance. Require
    // the admin to remove models and wait for jobs to clear first.
    const boundModels = await db
      .select({ id: aiModels.id })
      .from(aiModels)
      .where(eq(aiModels.providerId, id));
    if (boundModels.length > 0) {
      return c.json(
        bad(
          `Cannot delete provider: ${boundModels.length} model(s) are still bound to it. Remove the models first (or disable the provider instead).`,
          409,
        ),
        409,
      );
    }

    const referencingJobs = await db
      .select({ id: aiJobs.id })
      .from(aiJobs)
      .where(eq(aiJobs.providerId, id));
    if (referencingJobs.length > 0) {
      return c.json(
        bad(
          `Cannot delete provider: ${referencingJobs.length} generation job(s) still reference it. Disable the provider instead to keep job history intact.`,
          409,
        ),
        409,
      );
    }

    await db.delete(aiProviders).where(eq(aiProviders.id, id));
    return c.body(null, 204);
  } catch (error) {
    console.error("Failed to delete AI provider", error);
    return c.json(internal(), 500);
  }
});

// ---------------------------------------------------------------------------
// 5. AI Models (C6.3 — database-driven model configuration)
// ---------------------------------------------------------------------------

adminRoute.get("/models", async (c) => {
  try {
    const db = getDb();
    const providerId = c.req.query("providerId");
    const rows = providerId
      ? await db.select().from(aiModels).where(eq(aiModels.providerId, providerId))
      : await db.select().from(aiModels);

    const providerRows = await db.select().from(aiProviders);
    const providerMap = new Map(providerRows.map((p: any) => [p.id, p.name]));

    return c.json({ data: rows.map((m: any) => toModelDto(m, providerMap.get(m.providerId))) });
  } catch (error) {
    console.error("Failed to list AI models", error);
    return c.json(internal(), 500);
  }
});

adminRoute.get("/models/:id", async (c) => {
  try {
    const db = getDb();
    const id = c.req.param("id");
    const [m] = await db.select().from(aiModels).where(eq(aiModels.id, id));
    if (!m) {
      return c.json(bad("Model not found", 404), 404);
    }
    const providerName = await providerNameFor(db, m.providerId);
    return c.json({ data: toModelDto(m, providerName) });
  } catch (error) {
    console.error("Failed to get AI model", error);
    return c.json(internal(), 500);
  }
});

adminRoute.post("/models", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = adminCreateModelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const db = getDb();

    // Provider relationship: the model must bind to an existing provider.
    const [provider] = await db
      .select({ id: aiProviders.id, providerType: aiProviders.providerType })
      .from(aiProviders)
      .where(eq(aiProviders.id, parsed.data.providerId));
    if (!provider) {
      return c.json(bad("Provider not found — cannot bind a model to a nonexistent provider", 404), 404);
    }

    // Duplicate (providerId, modelId) is guarded by a unique index; fail
    // with a clear 409 instead of surfacing a DB error.
    const [duplicate] = await db
      .select({ id: aiModels.id })
      .from(aiModels)
      .where(
        and(eq(aiModels.providerId, parsed.data.providerId), eq(aiModels.modelId, parsed.data.modelId)),
      );
    if (duplicate) {
      return c.json(
        bad("A model with this external model ID already exists for this provider", 409),
        409,
      );
    }

    const [created] = await db
      .insert(aiModels)
      .values({
        providerId: parsed.data.providerId,
        name: parsed.data.name,
        modelId: parsed.data.modelId,
        capability: parsed.data.capability,
        jobTypes: parsed.data.jobTypes ?? null,
        enabled: parsed.data.enabled ?? true,
        metadata: parsed.data.metadata ?? null,
      })
      .$returningId();
    if (!created) {
      return c.json(internal(), 500);
    }

    const [row] = await db.select().from(aiModels).where(eq(aiModels.id, created.id));
    if (!row) {
      return c.json(internal(), 500);
    }
    return c.json({ data: toModelDto(row, await providerNameFor(db, row.providerId)) }, 201);
  } catch (error) {
    console.error("Failed to create AI model", error);
    return c.json(internal(), 500);
  }
});

adminRoute.patch("/models/:id", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = adminUpdateModelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const db = getDb();
    const id = c.req.param("id");
    const [existing] = await db.select().from(aiModels).where(eq(aiModels.id, id));
    if (!existing) {
      return c.json(bad("Model not found", 404), 404);
    }

    await db.update(aiModels).set({ ...parsed.data, updatedAt: new Date() }).where(eq(aiModels.id, id));

    const [updated] = await db.select().from(aiModels).where(eq(aiModels.id, id));
    if (!updated) {
      return c.json(internal(), 500);
    }
    return c.json({ data: toModelDto(updated, await providerNameFor(db, updated.providerId)) });
  } catch (error) {
    console.error("Failed to update AI model", error);
    return c.json(internal(), 500);
  }
});

adminRoute.delete("/models/:id", async (c) => {
  try {
    const db = getDb();
    const id = c.req.param("id");
    const [existing] = await db.select().from(aiModels).where(eq(aiModels.id, id));
    if (!existing) {
      return c.json(bad("Model not found", 404), 404);
    }

    // Safe-delete guard: jobs reference models ON DELETE SET NULL, so
    // deleting a used model would strip provenance from generation history.
    const referencingJobs = await db
      .select({ id: aiJobs.id })
      .from(aiJobs)
      .where(eq(aiJobs.modelId, id));
    if (referencingJobs.length > 0) {
      return c.json(
        bad(
          `Cannot delete model: ${referencingJobs.length} generation job(s) still reference it. Disable the model instead to keep job history intact.`,
          409,
        ),
        409,
      );
    }

    await db.delete(aiModels).where(eq(aiModels.id, id));
    return c.body(null, 204);
  } catch (error) {
    console.error("Failed to delete AI model", error);
    return c.json(internal(), 500);
  }
});

// ---------------------------------------------------------------------------
// 6. Generation Jobs
// ---------------------------------------------------------------------------

adminRoute.get("/jobs", async (c) => {
  try {
    const db = getDb();
    const statusFilter = c.req.query("status");
    const projectIdFilter = c.req.query("projectId");

    const conditions = [];
    if (statusFilter) {
      conditions.push(eq(aiJobs.status, statusFilter));
    }
    if (projectIdFilter) {
      conditions.push(eq(aiJobs.projectId, projectIdFilter));
    }

    const rows =
      conditions.length > 0
        ? await db.select().from(aiJobs).where(and(...conditions)).orderBy(desc(aiJobs.createdAt))
        : await db.select().from(aiJobs).orderBy(desc(aiJobs.createdAt));

    const projectRows = await db.select().from(projects);
    const projectMap = new Map(projectRows.map((p: any) => [p.id, p.name]));
    const providerRows = await db.select().from(aiProviders);
    const providerMap = new Map(providerRows.map((p: any) => [p.id, p.name]));

    const data = rows.map((job: any) => ({
      ...job,
      projectName: job.projectId ? projectMap.get(job.projectId) ?? null : null,
      providerName: job.providerId ? providerMap.get(job.providerId) ?? null : null,
    }));

    return c.json({ data });
  } catch (error) {
    console.error("Failed to list generation jobs", error);
    return c.json(internal(), 500);
  }
});

adminRoute.get("/jobs/:id", async (c) => {
  try {
    const db = getDb();
    const id = c.req.param("id");
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
    if (!job) {
      return c.json(bad("Job not found", 404), 404);
    }

    const [proj] = job.projectId
      ? await db.select().from(projects).where(eq(projects.id, job.projectId))
      : [null];
    const [prov] = job.providerId
      ? await db.select().from(aiProviders).where(eq(aiProviders.id, job.providerId))
      : [null];

    return c.json({
      data: {
        ...job,
        projectName: proj?.name ?? null,
        providerName: prov?.name ?? null,
      },
    });
  } catch (error) {
    console.error("Failed to get generation job", error);
    return c.json(internal(), 500);
  }
});

adminRoute.post("/jobs/:id/cancel", async (c) => {
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

// ---------------------------------------------------------------------------
// Stubs for future phases
// ---------------------------------------------------------------------------

adminRoute.get("/usage", stub("usage"));
adminRoute.get("/quotas", stub("quotas"));
adminRoute.get("/storage", stub("storage"));
adminRoute.get("/settings", stub("settings"));
adminRoute.get("/audit", stub("audit"));
adminRoute.get("/security", stub("security"));
