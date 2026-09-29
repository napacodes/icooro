import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import { productionPlanService, ProductionPlanError } from "../services/production_plan.js";
import {
  storyGenerationService,
  StoryGenerationError,
} from "../services/story_generation.js";
import {
  scriptGenerationService,
  ScriptGenerationError,
} from "../services/script_generation.js";
import {
  sceneGenerationService,
  SceneGenerationError,
} from "../services/scene_generation.js";
import {
  shotGenerationService,
  ShotGenerationError,
} from "../services/shot_generation.js";
import {
  promptGenerationService,
  PromptGenerationError,
} from "../services/prompt_generation.js";
import {
  createProductionPlanSchema,
  updateProductionPlanSchema,
  formatZodError,
} from "../validation/schemas.js";

type Status = 400 | 404 | 409 | 500 | 502;
const bad = (
  message: string,
  status: Status = 400,
  code = status === 404
    ? "NOT_FOUND"
    : status === 409
      ? "CONFLICT"
      : status === 502
        ? "BAD_GATEWAY"
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
 *
 * C7.2 adds the single AI-assisted step: POST .../production-plans/:id/story
 * generates the structured story synchronously (planning-time only) and
 * stores it in the plan payload. Project ownership and the plan/project
 * relationship are enforced here, exactly as for the other plan endpoints.
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

/**
 * C7.2 — Story generation (planning-time AI step).
 *
 * POST /projects/:projectId/production-plans/:id/story
 *
 * Generates the structured story synchronously and stores it under
 * `plan.story`. Body-less: the plan's request/preferences/duration provide
 * all the context. Ownership is enforced exactly like every other plan
 * endpoint: the project must exist and belong to the caller (admin
 * bypasses), and the plan must belong to that project (else 404).
 */
nestedProductionPlansRoute.post(
  "/projects/:projectId/production-plans/:id/story",
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    try {
      // Project ownership: the C7.1 mechanism, byte-identical to the other
      // plan endpoints (404 for missing or foreign projects).
      const userId = c.get("userId") as string | undefined;
      const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
      const [project] = await getDb()
        .select({ id: projects.id, ownerId: projects.ownerId })
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
        return c.json(bad("Project not found", 404), 404);
      }

      const result = await storyGenerationService.generateStory({
        projectId,
        productionPlanId: id,
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof StoryGenerationError) {
        return c.json(bad(error.message, error.status), error.status);
      }
      console.error("Failed to generate story", error);
      return c.json(internal(), 500);
    }
  },
);

/**
 * C7.3 — Script generation (planning-time AI step).
 *
 * POST /projects/:projectId/production-plans/:id/script
 *
 * Generates the structured script from the plan's story (required) and
 * persists it as a NEW ScriptVersion on the plan's episode — creating the
 * episode when the plan is unanchored. Previous versions are never touched.
 * The plan records only the reference (`plan.episodeId` /
 * `plan.scriptVersionId`). Ownership is enforced exactly like every other
 * plan endpoint; a wrong project/episode/plan relationship is a 404.
 */
nestedProductionPlansRoute.post(
  "/projects/:projectId/production-plans/:id/script",
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    try {
      // Project ownership: the C7.1 mechanism, byte-identical to the other
      // plan endpoints (404 for missing or foreign projects).
      const userId = c.get("userId") as string | undefined;
      const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
      const [project] = await getDb()
        .select({ id: projects.id, ownerId: projects.ownerId })
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
        return c.json(bad("Project not found", 404), 404);
      }

      const result = await scriptGenerationService.generateScript({
        projectId,
        productionPlanId: id,
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof ScriptGenerationError) {
        return c.json(bad(error.message, error.status), error.status);
      }
      console.error("Failed to generate script", error);
      return c.json(internal(), 500);
    }
  },
);

/**
 * C7.4 — Scene generation (planning-time AI step).
 *
 * POST /projects/:projectId/production-plans/:id/scenes
 *
 * Generates the structured scene list from the plan's story (required) and
 * script (required) and persists it as rows in the episode's EXISTING
 * scenes table — no parallel scene model, no SceneVersion, no migration.
 * Regeneration replaces only the previously generated (tracked) scene set;
 * manual scenes are never touched, and tracked scenes that already have
 * shots block regeneration (409). The plan records only the reference
 * (`plan.sceneIds`). Ownership is enforced exactly like every other plan
 * endpoint; a wrong project/episode/plan relationship is a 404.
 */
nestedProductionPlansRoute.post(
  "/projects/:projectId/production-plans/:id/scenes",
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    try {
      // Project ownership: the C7.1 mechanism, byte-identical to the other
      // plan endpoints (404 for missing or foreign projects).
      const userId = c.get("userId") as string | undefined;
      const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
      const [project] = await getDb()
        .select({ id: projects.id, ownerId: projects.ownerId })
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
        return c.json(bad("Project not found", 404), 404);
      }

      const result = await sceneGenerationService.generateSceneList({
        projectId,
        productionPlanId: id,
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof SceneGenerationError) {
        return c.json(bad(error.message, error.status), error.status);
      }
      console.error("Failed to generate scenes", error);
      return c.json(internal(), 500);
    }
  },
);

/**
 * C7.5 — Shot generation (planning-time AI step).
 *
 * POST /projects/:projectId/production-plans/:id/scenes/:sceneId/shots
 *
 * Generates the structured shot list for ONE scene from the plan's story,
 * script, and that scene, and persists it as rows in the scene's EXISTING
 * shots table — no parallel shot model and no `shot_versions` writes (that
 * table remains media-generation history). Regeneration replaces only the
 * previously generated (tracked) shot set of the target scene; manual
 * shots are never touched, and tracked shots with dependent data (shot
 * versions/characters/locations/props/assets) block regeneration (409) —
 * checked before the provider call and again before the first deletion.
 * The plan records only the reference (`plan.shotIds`, keyed by scene id).
 * The full project → plan → episode → scene chain is validated; anything
 * foreign is an indistinguishable 404.
 */
nestedProductionPlansRoute.post(
  "/projects/:projectId/production-plans/:id/scenes/:sceneId/shots",
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const sceneId = c.req.param("sceneId");
    try {
      // Project ownership: the C7.1 mechanism, byte-identical to the other
      // plan endpoints (404 for missing or foreign projects).
      const userId = c.get("userId") as string | undefined;
      const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
      const [project] = await getDb()
        .select({ id: projects.id, ownerId: projects.ownerId })
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
        return c.json(bad("Project not found", 404), 404);
      }

      const result = await shotGenerationService.generateShotsForScene({
        projectId,
        productionPlanId: id,
        sceneId,
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof ShotGenerationError) {
        return c.json(bad(error.message, error.status), error.status);
      }
      console.error("Failed to generate shots", error);
      return c.json(internal(), 500);
    }
  },
);

/**
 * C7.6 — Media prompt generation (planning-time AI step).
 *
 * POST /projects/:projectId/production-plans/:id/scenes/:sceneId/shots/:shotId/prompt
 *
 * Generates ONE media prompt for the target shot from the plan's story,
 * script, the scene, and the shot's own planned fields, and writes it into
 * the shot's EXISTING `shots.prompt` column — the field the manual C6
 * generation workflow already reads. NO `shot_versions` or `ai_jobs`
 * writes. Manual work is preserved: a non-null prompt on a shot NOT
 * tracked in `plan.promptedShotIds` is hand-authored and returns 409
 * rather than being silently overwritten; a tracked shot may always be
 * regenerated. The full project → plan → episode → scene → shot chain is
 * validated; anything foreign is an indistinguishable 404.
 */
nestedProductionPlansRoute.post(
  "/projects/:projectId/production-plans/:id/scenes/:sceneId/shots/:shotId/prompt",
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const sceneId = c.req.param("sceneId");
    const shotId = c.req.param("shotId");
    try {
      // Project ownership: the C7.1 mechanism, byte-identical to the other
      // plan endpoints (404 for missing or foreign projects).
      const userId = c.get("userId") as string | undefined;
      const userRole = (c.get("userRole") as "user" | "admin" | undefined) ?? "user";
      const [project] = await getDb()
        .select({ id: projects.id, ownerId: projects.ownerId })
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!project || (userId && userRole !== "admin" && project.ownerId !== userId)) {
        return c.json(bad("Project not found", 404), 404);
      }

      const result = await promptGenerationService.generateShotPrompt({
        projectId,
        productionPlanId: id,
        sceneId,
        shotId,
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof PromptGenerationError) {
        return c.json(bad(error.message, error.status), error.status);
      }
      console.error("Failed to generate prompt", error);
      return c.json(internal(), 500);
    }
  },
);
