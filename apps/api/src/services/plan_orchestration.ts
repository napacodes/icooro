import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { scripts } from "../db/schema/scripts.js";
import { storyContractSchema, type ProductionPlanStatus } from "@icooro/shared";
import { productionPlanService } from "./production_plan.js";
import { storyGenerationService } from "./story_generation.js";
import { scriptGenerationService } from "./script_generation.js";
import { sceneGenerationService } from "./scene_generation.js";
import { shotGenerationService, type ShotGenerationResult } from "./shot_generation.js";
import { promptGenerationService } from "./prompt_generation.js";

/**
 * C7.7 — Production plan orchestration.
 *
 * One synchronous, user-triggered call that completes the REMAINING AI
 * planning stages of a ProductionPlan by calling the EXISTING stage
 * services in sequence:
 *
 *   Story (C7.2) → Script (C7.3) → Scenes (C7.4) → Shots (C7.5) → Prompts (C7.6)
 *
 * Design rules (approved C7.7 contract):
 * - Gap-fill ONLY. Every stage first checks whether its output already
 *   exists and, when it does, is reported as `skipped` — never regenerated.
 *   Forced regeneration stays what it is today: the per-stage C7.2–C7.6
 *   endpoints. This is what makes retries safe: a retry after a partial
 *   run re-runs only the missing stages and cannot duplicate a script
 *   version, cannot churn a tracked scene/shot set, and cannot overwrite
 *   any existing (manual or AI) prompt.
 * - No internal HTTP. The stage services are called directly; each one
 *   re-validates its own prerequisites, so orchestration adds no new
 *   validation and never bypasses an ownership or state gate.
 * - Manual work is preserved. Manual scenes/shots are never targets;
 *   prompts are generated only for tracked shots whose prompt is still
 *   null, so the C7.6 manual-preservation rule can never fire, and
 *   existing AI prompts are left alone. Missing (manually deleted) tracked
 *   records are reported, never silently recreated.
 * - Planning-state only. The plan status is never changed here: no
 *   `ready_for_review`, no `approved` — review and approval stay under
 *   explicit user control. The stage services themselves refuse anything
 *   but `planning`, so the preflight gate below merely fails fast.
 * - Stop at the first stage failure. Earlier successful stages keep their
 *   persisted output (every stage service writes nothing on its own
 *   failure paths); later stages are reported `not_run`.
 * - No media generation. `ai_jobs`, `shot_versions`, assets and the C6
 *   submit/poll machinery are untouched — that handoff is a later
 *   milestone.
 *
 * KNOWN LIMITATION (process-local concurrency): the per-plan in-flight
 * guard below is an in-process `Set`, the same pattern as the C6
 * duplicate-submission guard in `generation_executor.ts`. It is NOT a
 * distributed lock; with multiple API instances two concurrent
 * orchestrations of the same plan could both run. Single-instance
 * deployments (the current posture) are fully protected.
 */

/** The five planning stages, in the fixed orchestration order. */
export const ORCHESTRATION_STAGES = [
  "story",
  "script",
  "scenes",
  "shots",
  "prompts",
] as const;

export type OrchestrationStage = (typeof ORCHESTRATION_STAGES)[number];

export type OrchestrationStageStatus =
  | "completed"
  | "skipped"
  | "partial"
  | "failed"
  | "not_run";

export interface OrchestrationStageReport {
  stage: OrchestrationStage;
  status: OrchestrationStageStatus;
  /** Human-readable reason for skipped / partial / failed / not_run stages. */
  reason?: string | undefined;
  /** Concise counts where practical. */
  generated?: number | undefined;
  skipped?: number | undefined;
  /** Tracked ids that no longer exist (manually deleted) — reported, never recreated. */
  missingTrackedIds?: string[] | undefined;
}

export interface OrchestrationReport {
  productionPlanId: string;
  /** Aggregate: any failed → failed; any partial → partial; else completed. */
  status: "completed" | "partial" | "failed";
  /** The `to` bound of the request (null = full sequence). */
  requestedTo: OrchestrationStage | null;
  stages: OrchestrationStageReport[];
  /** The final plan payload, same shape the stage services return. */
  plan: Record<string, unknown> | null;
}

/**
 * Thrown for preflight failures (missing plan, ownership mismatch, wrong
 * plan status, concurrent run). Carries the HTTP status the route should
 * surface, mirroring `ProductionPlanError` and the stage services' error
 * conventions: ownership problems read as 404 and state problems as 409.
 */
export class PlanOrchestrationError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "PlanOrchestrationError";
    this.status = status;
  }
}

/**
 * In-process, per-plan in-flight guard. Mirrors `submissionsInFlight` in
 * `generation_executor.ts`: a second concurrent orchestration of the SAME
 * plan is rejected with a 409 before any provider call; different plans
 * never block each other. Process-local by design — not a distributed lock.
 */
const orchestrationsInFlight = new Set<string>();

/** The only plan status from which orchestration may run. */
const ORCHESTRATION_ALLOWED_STATUS: ProductionPlanStatus = "planning";

/** True when `value` is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Filter an extracted id list down to its well-formed string entries. */
function filterTrackedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Collect the well-formed (scene id → string[]) entries from the payload's
 * `shotIds` map. Only scenes WITH at least one tracked shot id are kept —
 * a scene recorded without tracked ids has no tracked target and is
 * reported by the shots stage's skip reason instead.
 */
function trackedShotIdsByScene(plan: Record<string, unknown>): Record<string, string[]> {
  const raw = plan.shotIds;
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [sceneId, ids] of Object.entries(raw)) {
    const tracked = filterTrackedIds(ids);
    if (sceneId.length > 0 && tracked.length > 0) out[sceneId] = tracked;
  }
  return out;
}

export interface OrchestratePlanInput {
  projectId: string;
  productionPlanId: string;
  /** Optional stopping stage: run the sequence up to and including this stage. */
  to?: OrchestrationStage | undefined;
}

export class PlanOrchestrationService {
  /**
   * Runs the remaining planning stages of one plan in order and returns a
   * structured report. Ownership is enforced by the caller (the route's
   * standard C7.1 project-ownership block); the plan lookup here is scoped
   * to the project, so a plan from another project is a 404 by construction.
   */
  async orchestratePlan(input: OrchestratePlanInput): Promise<OrchestrationReport> {
    const stagesToRun = ORCHESTRATION_STAGES.slice(
      0,
      ORCHESTRATION_STAGES.indexOf(input.to ?? "prompts") + 1,
    );

    // Concurrency guard: reject a second concurrent run for the SAME plan
    // before doing any work. Cleanup is guaranteed by the finally below.
    if (orchestrationsInFlight.has(input.productionPlanId)) {
      throw new PlanOrchestrationError(
        "An orchestration is already in progress for this production plan. Wait for it to finish before starting another.",
        409,
      );
    }
    orchestrationsInFlight.add(input.productionPlanId);

    try {
      return await this.runStages(input, stagesToRun);
    } finally {
      orchestrationsInFlight.delete(input.productionPlanId);
    }
  }

  private async runStages(
    input: OrchestratePlanInput,
    stagesToRun: readonly OrchestrationStage[],
  ): Promise<OrchestrationReport> {
    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const existing = await productionPlanService.getPlan(
      input.productionPlanId,
      input.projectId,
    );
    if (!existing) {
      throw new PlanOrchestrationError("Production plan not found", 404);
    }

    // 2. State gate: fail fast with the same message shape the stage
    //    services use (each stage re-checks this itself, so this is purely
    //    a preflight — orchestration never changes plan status).
    if ((existing.status as ProductionPlanStatus) !== ORCHESTRATION_ALLOWED_STATUS) {
      throw new PlanOrchestrationError(
        `Orchestration can only run while the production plan is in "${ORCHESTRATION_ALLOWED_STATUS}" status (current status: "${existing.status}")`,
        409,
      );
    }

    const stageReports: OrchestrationStageReport[] = [];
    let currentPlan: Record<string, unknown> | null = isPlainObject(existing.plan)
      ? existing.plan
      : null;

    const markNotRun = (from: number) => {
      for (let i = from; i < stagesToRun.length; i++) {
        stageReports.push({
          stage: stagesToRun[i]!,
          status: "not_run",
          reason: "An earlier stage failed; this stage was not attempted.",
        });
      }
    };

    for (let i = 0; i < stagesToRun.length; i++) {
      const stage = stagesToRun[i]!;
      let report: OrchestrationStageReport;
      try {
        report = await this.runStage(stage, input, currentPlan ?? {});
      } catch (error) {
        // Stage services throw typed errors on their own failure paths;
        // a stage failure is stage data, not a request-level error —
        // earlier stages keep their persisted output either way.
        report = {
          stage,
          status: "failed",
          reason:
            error instanceof Error
              ? error.message
              : "An unexpected orchestration error occurred.",
        };
      }
      stageReports.push(report);
      if (report.status === "failed") {
        markNotRun(i + 1);
        break;
      }

      // Re-read the payload the stage persisted so the next stage's skip
      // checks see it (each service re-reads the plan itself; this keeps
      // the orchestrator's notion of "what exists" in sync without
      // duplicating any persistence logic).
      const refreshed = await productionPlanService.getPlan(
        input.productionPlanId,
        input.projectId,
      );
      if (refreshed) {
        currentPlan = isPlainObject(refreshed.plan) ? refreshed.plan : null;
      }
    }

    // Aggregate: any failed → failed; any partial → partial; else completed.
    const hasFailure = stageReports.some((r) => r.status === "failed");
    const hasPartial = stageReports.some((r) => r.status === "partial");

    return {
      productionPlanId: input.productionPlanId,
      status: hasFailure ? "failed" : hasPartial ? "partial" : "completed",
      requestedTo: input.to ?? null,
      stages: stageReports,
      plan: currentPlan,
    };
  }

  /**
   * Runs one stage. Each branch only decides whether the stage's output
   * already exists (skip) or not (call the existing service as-is). No
   * business logic is duplicated: extraction helpers are the services'
   * own public extractors, and every generation path is the service's own
   * method with its full prerequisite validation.
   */
  private async runStage(
    stage: OrchestrationStage,
    input: OrchestratePlanInput,
    plan: Record<string, unknown>,
  ): Promise<OrchestrationStageReport> {
    switch (stage) {
      case "story":
        return await this.runStoryStage(input, plan);
      case "script":
        return await this.runScriptStage(input, plan);
      case "scenes":
        return await this.runScenesStage(input, plan);
      case "shots":
        return await this.runShotsStage(input, plan);
      case "prompts":
        return await this.runPromptsStage(input, plan);
    }
  }

  /**
   * Story: skip when the payload already carries a contract-valid story
   * (the payload is user-editable, so it is re-validated rather than
   * trusted — the same rule the downstream services apply).
   */
  private async runStoryStage(
    input: OrchestratePlanInput,
    plan: Record<string, unknown>,
  ): Promise<OrchestrationStageReport> {
    if (storyContractSchema.safeParse(plan.story).success) {
      return { stage: "story", status: "skipped", reason: "A valid story already exists." };
    }
    await storyGenerationService.generateStory({
      projectId: input.projectId,
      productionPlanId: input.productionPlanId,
    });
    return { stage: "story", status: "completed", generated: 1 };
  }

  /**
   * Script: skip when the plan references a script version that exists AND
   * belongs to the resolved episode (plan row episodeId, then payload
   * episodeId — the same precedence the services use). Missing/invalid
   * references fall through to generation, which re-validates everything
   * itself (creating the episode when the plan is unanchored).
   */
  private async runScriptStage(
    input: OrchestratePlanInput,
    plan: Record<string, unknown>,
  ): Promise<OrchestrationStageReport> {
    const episodeId =
      typeof plan.episodeId === "string" && plan.episodeId.length > 0
        ? plan.episodeId
        : null;
    const scriptVersionId =
      typeof plan.scriptVersionId === "string" && plan.scriptVersionId.length > 0
        ? plan.scriptVersionId
        : null;

    if (episodeId !== null && scriptVersionId !== null) {
      const rows = (await getDb()
        .select({ id: scripts.id, episodeId: scripts.episodeId })
        .from(scripts)
        .where(eq(scripts.id, scriptVersionId))) as unknown as Array<{
        id: unknown;
        episodeId: unknown;
      }>;
      const row = rows[0];
      if (row && row.id === scriptVersionId && row.episodeId === episodeId) {
        return {
          stage: "script",
          status: "skipped",
          reason: "The referenced script version already exists on the plan's episode.",
        };
      }
    }

    await scriptGenerationService.generateScript({
      projectId: input.projectId,
      productionPlanId: input.productionPlanId,
    });
    return { stage: "script", status: "completed", generated: 1 };
  }

  /**
   * Scenes: gap-fill over the plan's TRACKED scene ids. Tracked scenes that
   * still exist are kept as-is (never regenerated here); tracked ids that
   * no longer exist are reported as missing and never silently recreated.
   * With no tracked scenes at all, the scene service generates the initial
   * set. Missing tracked records make the stage `partial`, not failed —
   * the run continues, since shots can proceed over the surviving scenes.
   */
  private async runScenesStage(
    input: OrchestratePlanInput,
    plan: Record<string, unknown>,
  ): Promise<OrchestrationStageReport> {
    const trackedIds = sceneGenerationService.extractSceneIdsFromPlan(plan);
    if (trackedIds.length === 0) {
      const result = await sceneGenerationService.generateSceneList({
        projectId: input.projectId,
        productionPlanId: input.productionPlanId,
      });
      return { stage: "scenes", status: "completed", generated: result.scenes.length };
    }

    const rows = (await getDb()
      .select({ id: scenes.id })
      .from(scenes)) as unknown as Array<{ id: unknown }>;
    const existingIds = new Set(
      rows.filter((r) => typeof r.id === "string").map((r) => r.id as string),
    );
    const missing = trackedIds.filter((id) => !existingIds.has(id));

    if (missing.length > 0) {
      return {
        stage: "scenes",
        status: "partial",
        generated: 0,
        skipped: trackedIds.length - missing.length,
        missingTrackedIds: missing,
        reason:
          "Some tracked scenes no longer exist (manually deleted). Orchestration does not recreate them; regenerate scenes explicitly with the C7.4 endpoint if you want a new AI scene set.",
      };
    }
    return {
      stage: "scenes",
      status: "skipped",
      generated: 0,
      skipped: trackedIds.length,
      reason: "All tracked scenes still exist.",
    };
  }

  /**
   * Shots: gap-fill over the plan's tracked shot ids per scene. Scenes with
   * tracked shots that all still exist are skipped; tracked shots that no
   * longer exist are reported as missing and never silently recreated;
   * tracked scenes that no longer exist are reported as missing scenes.
   * Every scene that has NO tracked shot ids (including scenes the
   * orchestrator itself just created in the scenes stage) gets AI shots.
   * One scene's generation failure fails the whole stage (later stages do
   * not run) without deleting anything; other scenes' already-persisted
   * shot rows are kept.
   */
  private async runShotsStage(
    input: OrchestratePlanInput,
    plan: Record<string, unknown>,
  ): Promise<OrchestrationStageReport> {
    const shotIdsByScene = trackedShotIdsByScene(plan);
    const trackedSceneIds = sceneGenerationService.extractSceneIdsFromPlan(plan);

    // Scenes eligible for AI shot generation: every tracked scene WITHOUT
    // tracked shot ids. Scenes with tracked ids are validated below.
    const scenesNeedingShots = trackedSceneIds.filter(
      (sceneId) => (shotIdsByScene[sceneId]?.length ?? 0) === 0,
    );

    const existingSceneIds = await this.listSceneIds();

    const missingSceneIds: string[] = [];
    const missingShotIds: string[] = [];
    let skippedShots = 0;

    for (const [sceneId, trackedShotIds] of Object.entries(shotIdsByScene)) {
      if (!existingSceneIds.has(sceneId)) {
        if (!missingSceneIds.includes(sceneId)) missingSceneIds.push(sceneId);
        continue;
      }
      const existingShotIds = await this.listShotIds(sceneId);
      const missing = trackedShotIds.filter((id) => !existingShotIds.has(id));
      if (missing.length > 0) {
        for (const id of missing) {
          if (!missingShotIds.includes(id)) missingShotIds.push(id);
        }
      }
      skippedShots += trackedShotIds.length - missing.length;
    }

    const generatedShots: string[] = [];
    const sceneFailures: Array<{ sceneId: string; message: string }> = [];

    for (const sceneId of scenesNeedingShots) {
      if (!existingSceneIds.has(sceneId)) {
        if (!missingSceneIds.includes(sceneId)) missingSceneIds.push(sceneId);
        continue;
      }
      try {
        const result: ShotGenerationResult = await shotGenerationService.generateShotsForScene({
          projectId: input.projectId,
          productionPlanId: input.productionPlanId,
          sceneId,
        });
        generatedShots.push(...result.shots.map((s) => s.id));
      } catch (error) {
        sceneFailures.push({
          sceneId,
          message: error instanceof Error ? error.message : "Shot generation failed.",
        });
        break;
      }
    }

    if (sceneFailures.length > 0) {
      return {
        stage: "shots",
        status: "failed",
        generated: generatedShots.length > 0 ? generatedShots.length : undefined,
        skipped: skippedShots > 0 ? skippedShots : undefined,
        reason: `Shot generation failed for a tracked scene: ${sceneFailures[0]!.message}`,
      };
    }

    if (missingSceneIds.length > 0 || missingShotIds.length > 0) {
      const reasonParts: string[] = [];
      if (missingSceneIds.length > 0) {
        reasonParts.push(
          "Some tracked scenes no longer exist (manually deleted); their shots were not regenerated.",
        );
      }
      if (missingShotIds.length > 0) {
        reasonParts.push(
          "Some tracked shots no longer exist (manually deleted); they were not recreated.",
        );
      }
      return {
        stage: "shots",
        status: "partial",
        generated: generatedShots.length > 0 ? generatedShots.length : undefined,
        skipped: skippedShots > 0 ? skippedShots : undefined,
        missingTrackedIds: [...missingSceneIds, ...missingShotIds],
        reason: reasonParts.join(" "),
      };
    }

    if (generatedShots.length > 0) {
      return { stage: "shots", status: "completed", generated: generatedShots.length };
    }

    return {
      stage: "shots",
      status: "skipped",
      skipped: skippedShots > 0 ? skippedShots : undefined,
      reason: "All tracked scenes already have their tracked shots.",
    };
  }

  /** All scene ids in the current database snapshot. */
  private async listSceneIds(): Promise<Set<string>> {
    const rows = (await getDb()
      .select({ id: scenes.id })
      .from(scenes)) as unknown as Array<{ id: unknown }>;
    return new Set(
      rows.filter((r) => typeof r.id === "string").map((r) => r.id as string),
    );
  }

  /** All shot ids belonging to one scene, from the current snapshot. */
  private async listShotIds(sceneId: string): Promise<Set<string>> {
    const rows = (await getDb()
      .select({ id: shots.id })
      .from(shots)
      .where(eq(shots.sceneId, sceneId))) as unknown as Array<{ id: unknown }>;
    return new Set(
      rows.filter((r) => typeof r.id === "string").map((r) => r.id as string),
    );
  }

  /**
   * Prompts: generate only for tracked shots whose prompt is null. Tracked
   * shots with a prompt (AI-authored or manual) are left untouched; the
   * C7.6 manual-preservation 409 therefore cannot fire. Shots of scenes
   * that no longer exist are reported as missing. The prompt service's own
   * per-shot failures do not abort the stage: remaining shots still get
   * prompts, and the stage reports `failed` when any shot failed.
   */
  private async runPromptsStage(
    input: OrchestratePlanInput,
    plan: Record<string, unknown>,
  ): Promise<OrchestrationStageReport> {
    const trackedSceneIds = sceneGenerationService.extractSceneIdsFromPlan(plan);
    const shotIdsByScene = trackedShotIdsByScene(plan);

    const targets: Array<{ sceneId: string; shotId: string }> = [];
    for (const sceneId of trackedSceneIds) {
      const trackedShotIds = shotIdsByScene[sceneId] ?? [];
      if (trackedShotIds.length === 0) continue;

      const shotRows = (await getDb()
        .select({ id: shots.id, prompt: shots.prompt })
        .from(shots)
        .where(eq(shots.sceneId, sceneId))) as unknown as Array<{
        id: unknown;
        prompt: unknown;
      }>;
      const promptByShotId = new Map<string, unknown>();
      for (const row of shotRows) {
        if (typeof row.id === "string") promptByShotId.set(row.id, row.prompt);
      }
      for (const shotId of trackedShotIds) {
        // Row absence (manually deleted) is reported as missing, never recreated.
        if (!promptByShotId.has(shotId)) continue;
        const prompt = promptByShotId.get(shotId);
        // A non-empty prompt is hand-authored or already AI-generated —
        // leave it untouched (null/empty means the shot still needs one).
        if (typeof prompt === "string" && prompt.length > 0) continue;
        targets.push({ sceneId, shotId });
      }
    }

    if (targets.length === 0) {
      const trackedShotCount = trackedSceneIds.reduce(
        (sum, sceneId) => sum + (shotIdsByScene[sceneId]?.length ?? 0),
        0,
      );
      return {
        stage: "prompts",
        status: "skipped",
        skipped: trackedShotCount > 0 ? trackedShotCount : undefined,
        reason:
          trackedShotCount > 0
            ? "Every tracked shot already has a media prompt."
            : "No tracked shots are recorded on the plan, so there is nothing to prompt. Generate shots first (C7.5).",
      };
    }

    let generatedPrompts = 0;
    const failures: Array<{ sceneId: string; shotId: string; message: string }> = [];
    for (const target of targets) {
      try {
        await promptGenerationService.generateShotPrompt({
          projectId: input.projectId,
          productionPlanId: input.productionPlanId,
          sceneId: target.sceneId,
          shotId: target.shotId,
        });
        generatedPrompts += 1;
      } catch (error) {
        failures.push({
          sceneId: target.sceneId,
          shotId: target.shotId,
          message: error instanceof Error ? error.message : "Prompt generation failed.",
        });
      }
    }

    if (failures.length > 0) {
      return {
        stage: "prompts",
        status: "failed",
        generated: generatedPrompts > 0 ? generatedPrompts : undefined,
        reason: failures[0]!.message,
      };
    }
    return { stage: "prompts", status: "completed", generated: generatedPrompts };
  }
}

export const planOrchestrationService = new PlanOrchestrationService();
