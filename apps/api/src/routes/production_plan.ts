import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import { productionPlanService, ProductionPlanError } from "../services/production_plan.js";
import {
  createProductionPlanSchema,
  updateProductionPlanSchema,
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
const internal = () => bad("An unexpected error occurred", 500, "INTERNAL_ERROR");

async function parseJsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * C7.1 — AI Production Director foundation routes.
 *
 * Project-scoped like the nested generation-jobs routes, with the same
 * ownership contract: a plan from another user's project is a 404, never a
 * 403 (don't reveal existence). C7.1 creates/retrieves/updates local plan
 * records only — no AI/provider call ever runs from these endpoints.
 */
export const nestedProductionPlansRoute = new Hono();

nestedProductionPlansRoute.onError((error) => {
  console.error("Unhandled nestedProductionPlansRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

nestedProductionPlansRoute.post("/projects/:projectId/production-plans", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }

  const parsed = createProductionPlanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    // Project ownership: mirrors the generation-jobs route contract.
    const userId = c.get("userId") as string | undefined;
    const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
    const [project] = await getDb()
      .select({ id: projects.id, ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
      return c.json(bad("Project not found", 404), 404);
    }

    const created = await productionPlanService.createPlan({
      projectId,
      request: parsed.data.request,
      episodeId: parsed.data.episodeId,
      preferences: parsed.data.preferences,
    });
    return c.json({ data: created }, 201);
  } catch (error) {
    if (error instanceof ProductionPlanError) {
      return c.json(bad(error.message, error.status), error.status);
    }
    console.error("Failed to create production plan", error);
    return c.json(internal(), 500);
  }
});

nestedProductionPlansRoute.get("/projects/:projectId/production-plans", async (c) => {
  const projectId = c.req.param("projectId");
  try {
    const userId = c.get("userId") as string | undefined;
    const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
    const [project] = await getDb()
      .select({ id: projects.id, ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
      return c.json(bad("Project not found", 404), 404);
    }

    const plans = await productionPlanService.listProjectPlans(projectId);
    return c.json({ data: plans });
  } catch (error) {
    console.error("Failed to list production plans", error);
    return c.json(internal(), 500);
  }
});

nestedProductionPlansRoute.get("/projects/:projectId/production-plans/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  try {
    const userId = c.get("userId") as string | undefined;
    const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
    const [project] = await getDb()
      .select({ id: projects.id, ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
      return c.json(bad("Project not found", 404), 404);
    }

    const plan = await productionPlanService.getPlan(id, projectId);
    if (!plan) {
      return c.json(bad("Production plan not found", 404), 404);
    }
    return c.json({ data: plan });
  } catch (error) {
    console.error("Failed to get production plan", error);
    return c.json(internal(), 500);
  }
});

nestedProductionPlansRoute.patch("/projects/:projectId/production-plans/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }

  const parsed = updateProductionPlanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const userId = c.get("userId") as string | undefined;
    const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
    const [project] = await getDb()
      .select({ id: projects.id, ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
      return c.json(bad("Project not found", 404), 404);
    }

    const updated = await productionPlanService.updatePlan(id, projectId, parsed.data);
    if (!updated) {
      return c.json(bad("Production plan not found", 404), 404);
    }
    return c.json({ data: updated });
  } catch (error) {
    if (error instanceof ProductionPlanError) {
      return c.json(bad(error.message, error.status), error.status);
    }
    console.error("Failed to update production plan", error);
    return c.json(internal(), 500);
  }
});
