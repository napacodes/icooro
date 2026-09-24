import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { productionPlans } from "../db/schema/production_plans.js";
import { episodes } from "../db/schema/episodes.js";
import { projects } from "../db/schema/projects.js";
import {
  PRODUCTION_PLAN_STATUSES,
  type ProductionPlanStatus,
} from "@icooro/shared";

/**
 * ProductionPlan service (C7.1 — AI Production Director foundation).
 *
 * This is the persistent backbone of the AI Production Director: it stores
 * a project-owned plan record for an AI-assisted production run and
 * validates its lifecycle. It deliberately orchestrates NOTHING yet — no
 * episodes/scenes/shots are created here, and no AI/provider call is ever
 * made (C7.1 is the foundation; later C7 phases build on it).
 */

/**
 * Thrown for invalid plan access, malformed references, or illegal
 * lifecycle changes. Carries the HTTP status the route should surface so
 * ownership problems read as 404 and state problems as 409 — the same
 * conventions the generation and storytelling surfaces use.
 */
export class ProductionPlanError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "ProductionPlanError";
    this.status = status;
  }
}

/**
 * Plan lifecycle (C7.1):
 *
 *   planning ──→ ready_for_review ──→ approved (terminal)
 *       │              │    │
 *       │              │    └──→ planning   (edits send it back to planning)
 *       └──────┬───────┴────┴───→ cancelled / failed (terminal)
 *
 * Terminal states only ever transition to themselves. The small explicit
 * map mirrors `VALID_TRANSITIONS` in the generation service.
 */
const PLAN_TRANSITIONS: Record<ProductionPlanStatus, readonly ProductionPlanStatus[]> = {
  planning: ["planning", "ready_for_review", "cancelled", "failed"],
  ready_for_review: ["ready_for_review", "planning", "approved", "cancelled", "failed"],
  approved: ["approved"],
  cancelled: ["cancelled"],
  failed: ["failed"],
};

export function isValidPlanStatusTransition(
  from: ProductionPlanStatus,
  to: ProductionPlanStatus,
): boolean {
  if (from === to) return true;
  return PLAN_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses whose plan payload may still be edited. */
function isPlanEditable(status: ProductionPlanStatus): boolean {
  return status === "planning" || status === "ready_for_review";
}

export interface CreateProductionPlanParams {
  projectId: string;
  request: string;
  episodeId?: string | null | undefined;
  preferences?: Record<string, unknown> | null | undefined;
}

export interface UpdateProductionPlanParams {
  plan?: Record<string, unknown> | null | undefined;
  targetDurationSeconds?: number | null | undefined;
  status?: ProductionPlanStatus | undefined;
}

export class ProductionPlanService {
  /**
   * Creates a local draft plan. No AI/provider call happens here — the
   * plan starts empty and a later phase fills it in.
   */
  async createPlan(input: CreateProductionPlanParams) {
    const db = getDb();

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    if (!project) {
      throw new ProductionPlanError("Project not found", 404);
    }

    // The anchor episode must exist and belong to the same project — strict
    // project isolation, identical to the generation-job ownership checks.
    if (input.episodeId) {
      const [episode] = await db
        .select({ id: episodes.id, projectId: episodes.projectId })
        .from(episodes)
        .where(eq(episodes.id, input.episodeId));
      if (!episode || episode.projectId !== input.projectId) {
        throw new ProductionPlanError("Episode not found", 404);
      }
    }

    const values = {
      projectId: input.projectId,
      episodeId: input.episodeId ?? null,
      request: input.request,
      status: "planning" as const,
      plan: null,
      targetDurationSeconds: null,
      preferences: input.preferences ?? null,
    };

    const [created] = await db.insert(productionPlans).values(values).$returningId();
    if (!created) throw new ProductionPlanError("Failed to create production plan", 400);

    const plan = await this.getPlan(created.id, input.projectId);
    if (!plan) throw new ProductionPlanError("Failed to create production plan", 400);
    return plan;
  }

  /**
   * Fetches one plan scoped to its project. Passing `projectId` makes
   * cross-project reads impossible by construction — a plan from another
   * project is indistinguishable from a missing one (404, not 403).
   */
  async getPlan(planId: string, projectId: string) {
    const [row] = await getDb()
      .select()
      .from(productionPlans)
      .where(and(eq(productionPlans.id, planId), eq(productionPlans.projectId, projectId)));
    return row ?? null;
  }

  async listProjectPlans(projectId: string) {
    return await getDb()
      .select()
      .from(productionPlans)
      .where(eq(productionPlans.projectId, projectId))
      .orderBy(desc(productionPlans.createdAt));
  }

  /**
   * Applies a partial update: either an explicit status transition, plan
   * payload edits, or both. Payload edits are only allowed while the plan
   * is editable (planning / ready_for_review); terminal plans are frozen.
   */
  async updatePlan(planId: string, projectId: string, input: UpdateProductionPlanParams) {
    const existing = await this.getPlan(planId, projectId);
    if (!existing) {
      throw new ProductionPlanError("Production plan not found", 404);
    }

    const currentStatus = existing.status as ProductionPlanStatus;
    const targetStatus = input.status ?? currentStatus;
    if (!isValidPlanStatusTransition(currentStatus, targetStatus)) {
      throw new ProductionPlanError(
        `Invalid production plan status transition from "${currentStatus}" to "${targetStatus}"`,
        409,
      );
    }

    const payloadChanging =
      input.plan !== undefined || input.targetDurationSeconds !== undefined;
    if (payloadChanging && !isPlanEditable(targetStatus)) {
      throw new ProductionPlanError(
        `Production plan payload cannot be edited while in "${targetStatus}" status`,
        409,
      );
    }

    const updateValues: Record<string, unknown> = {};
    if (input.plan !== undefined) updateValues.plan = input.plan;
    if (input.targetDurationSeconds !== undefined) {
      updateValues.targetDurationSeconds = input.targetDurationSeconds;
    }
    if (input.status !== undefined) updateValues.status = input.status;

    if (Object.keys(updateValues).length > 0) {
      await getDb().update(productionPlans).set(updateValues).where(eq(productionPlans.id, planId));
    }

    return await this.getPlan(planId, projectId);
  }
}

export const productionPlanService = new ProductionPlanService();

/** Guard so the shared status union stays in sync with the state machine. */
export const PRODUCTION_PLAN_STATUS_VALUES: readonly ProductionPlanStatus[] =
  PRODUCTION_PLAN_STATUSES;
