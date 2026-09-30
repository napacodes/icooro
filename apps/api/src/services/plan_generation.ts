import { and, eq, inArray } from "drizzle-orm";
import {
  PLAN_GENERATION_JOB_TYPE,
  PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY,
  type JobStatus,
  type PlanGenerationItemFailure,
  type PlanGenerationJobRef,
  type PlanGenerationReport,
  type PlanGenerationReportStatus,
} from "@icooro/shared";
import { getDb } from "../db/index.js";
import { aiJobs } from "../db/schema/ai_jobs.js";
import { episodes } from "../db/schema/episodes.js";
import { productionPlans } from "../db/schema/production_plans.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { generationJobService } from "./generation.js";
import { productionPlanService } from "./production_plan.js";
import { sceneGenerationService } from "./scene_generation.js";

/**
 * C8.1 — Media generation entry point for an approved ProductionPlan.
 *
 * POST /projects/:projectId/production-plans/:id/generate
 *
 * This is the handoff milestone the C7.7 orchestrator deliberately stopped
 * short of: it turns an APPROVED plan's tracked planning output into real
 * media-generation work, using ONLY the existing C6 generation
 * infrastructure — it never executes, submits, polls or downloads anything
 * itself.
 *
 * What it reuses (and what it deliberately does not reinvent):
 * - `productionPlanService.getPlan` — project-scoped plan lookup, so a plan
 *   from another project is an indistinguishable 404.
 * - The tracked plan references recorded by C7.4/C7.5
 *   (`plan.sceneIds`, `plan.shotIds` map) — the same extractors the C7.7
 *   orchestrator uses. Shots the user touched by hand after planning are
 *   NOT generated; only tracked shots are eligible.
 * - `generationJobService.createJob` — the existing C6 job creation
 *   service with its full validation chain: entity hierarchy/ownership,
 *   enabled provider/model checks, capability and job-type validation, and
 *   C6.8.2 automatic provider/model routing (the endpoint never names a
 *   provider). Jobs are created in `queued` status; the existing C5.2
 *   executor (`POST /jobs/:id/submit`, `poll`) picks them up exactly like
 *   manual C6 jobs.
 * - `PLAN_GENERATION_JOB_TYPE` ("text-to-video") with the shot's existing
 *   `shots.prompt` (written by C7.6 or by hand) as the job prompt.
 *
 * Protections:
 * - Approval gate: the plan must be in `approved` status — the terminal
 *   state reached only through the user-driven C7.1 review flow. No status
 *   is ever changed here (approved stays approved; nothing is silently
 *   approved, regenerated or reset). The gate is checked BEFORE the
 *   transaction and re-checked inside the lock, so a plan cancelled while
 *   a request was in flight is refused.
 * - Duplicate submission (concurrency-safe): the dedup check AND the job
 *   inserts run while the plan's row lock is held, using the repository's
 *   established `SELECT ... FOR UPDATE` pattern (the same one
 *   `completeJobWithAssetVersion` uses for its job-link guard). A second
 *   concurrent request for the SAME plan blocks on that lock; when it
 *   proceeds it re-reads active jobs inside its transaction and therefore
 *   observes the first request's committed jobs — reporting them as
 *   `alreadyActive` instead of creating duplicates. Requests for DIFFERENT
 *   plans take different row locks and do not serialize against each
 *   other. Terminal jobs (completed/failed/cancelled) never block
 *   re-generation; manual C6 jobs (no `metadata.productionPlanId`) are
 *   never hijacked. Job inserts go through `generationJobService.createJob`
 *   (pool connection) and complete BEFORE the lock is released, so the
 *   serialized waiter always sees them committed.
 * - Payload tracking: every successfully created job id is appended to the
 *   plan payload's `generatedJobIds` (flat string array, same convention
 *   as `promptedShotIds`), merged over the freshest payload read inside
 *   the lock so unrelated keys survive and concurrent generate calls
 *   cannot overwrite each other. Append-only and duplicate-free: the list
 *   records every job ever initiated from this plan (including jobs that
 *   later finished or failed); `ai_jobs` remains the single source of
 *   truth for job status — no operational state is copied into the plan.
 * - Partial-failure semantics: each tracked shot is accepted or rejected
 *   independently. Already-created jobs are reported, never hidden; the
 *   aggregate `status` is `completed` only when every eligible shot was
 *   accepted.
 *
 * KNOWN LIMITATION (crash window, repo-wide posture): job inserts (via
 * `createJob` on the pool) commit before the plan lock is released, but
 * the payload-tracking write commits with the lock transaction. A process
 * crash between the two can leave created jobs that are correct but
 * untracked in `generatedJobIds` — the same non-atomic two-write posture
 * C7.3–C7.6 document. The dedup guarantee itself does not depend on the
 * payload: it re-reads `ai_jobs` inside the lock.
 */

/** The only plan status from which media generation may start. */
const GENERATION_ALLOWED_STATUS = "approved";

/**
 * ai_jobs statuses that count as work already in flight for deduplication.
 * Terminal jobs (completed/failed/cancelled) never block a resubmission.
 */
const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "submitted", "processing", "downloading"];

export class PlanGenerationError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "PlanGenerationError";
    this.status = status;
  }
}

/** True when `value` is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface StartPlanGenerationInput {
  projectId: string;
  productionPlanId: string;
}

/**
 * Minimal transaction handle: the subset of the Drizzle MySQL transaction
 * API this service uses (select/from/where[.for("update")], update/set/
 * where). Declared loosely with an index signature because the real Drizzle
 * builder's chainable type has no narrow structural twin; tests pass their
 * fake tx through the same shape.
 */
interface PlanGenerationTx {
  [key: string]: any;
}

export class PlanGenerationService {
  /**
   * Creates queued media-generation jobs for the tracked shots of an
   * APPROVED production plan. Ownership is enforced by the caller (the
   * route's standard C7.1 project-ownership block); the plan lookup here
   * is scoped to the project, so a plan from another project is a 404 by
   * construction.
   */
  async startGeneration(input: StartPlanGenerationInput): Promise<PlanGenerationReport> {
    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const plan = await productionPlanService.getPlan(input.productionPlanId, input.projectId);
    if (!plan) {
      throw new PlanGenerationError("Production plan not found", 404);
    }

    // 2. Approval gate: media generation starts only from an APPROVED plan.
    //    `planning` / `ready_for_review` must go through the user-driven
    //    C7.1 review flow first; nothing here approves, bypasses or resets.
    if ((plan.status as string) !== GENERATION_ALLOWED_STATUS) {
      throw new PlanGenerationError(
        `Media generation can only start from an approved production plan (current status: "${plan.status}"). Move the plan through review and approval first.`,
        409,
      );
    }

    // 3. The plan must still be anchored to an episode whose scenes/shots
    //    hold the tracked production data (plan row's episodeId, then the
    //    payload's episodeId — the C7.3–C7.6 precedence).
    const payload = isPlainObject(plan.plan) ? plan.plan : {};
    const episodeId =
      typeof plan.episodeId === "string"
        ? plan.episodeId
        : typeof payload.episodeId === "string"
          ? payload.episodeId
          : null;
    if (!episodeId) {
      throw new PlanGenerationError(
        "This production plan is not anchored to an episode, so there is no production data to generate from.",
        400,
      );
    }

    // 4. Tracked scenes/shots: the C7.4/C7.5 recorded references, extracted
    //    with the same helpers the C7.7 orchestrator uses. Manual work is
    //    never a target.
    const trackedSceneIds = sceneGenerationService.extractSceneIdsFromPlan(plan.plan);
    const shotIdsByScene = this.extractTrackedShotIdsByScene(plan.plan);

    const eligibleShots: Array<{ sceneId: string; shotId: string }> = [];
    for (const sceneId of trackedSceneIds) {
      for (const shotId of shotIdsByScene[sceneId] ?? []) {
        eligibleShots.push({ sceneId, shotId });
      }
    }

    if (eligibleShots.length === 0) {
      throw new PlanGenerationError(
        "This production plan has no tracked shots to generate. Generate scenes and shots first (C7.4/C7.5) before starting media generation.",
        400,
      );
    }

    // 5. Load the tracked rows scoped through the plan's episode: a shot id
    //    that no longer exists, moved scene, or foreign scene is reported
    //    per shot instead of silently generating from stale references.
    const episodeRows = await getDb()
      .select({ id: episodes.id })
      .from(episodes)
      .where(and(eq(episodes.id, episodeId), eq(episodes.projectId, input.projectId)));
    const episodeRow = episodeRows[0];
    if (!episodeRow || typeof episodeRow.id !== "string") {
      throw new PlanGenerationError(
        "The episode anchored to this production plan was not found in its project.",
        404,
      );
    }

    const sceneRows = await getDb()
      .select({ id: scenes.id, episodeId: scenes.episodeId })
      .from(scenes)
      .where(inArray(scenes.id, trackedSceneIds));

    const shotRows = await getDb()
      .select({
        id: shots.id,
        sceneId: shots.sceneId,
        prompt: shots.prompt,
      })
      .from(shots)
      .where(
        inArray(
          shots.id,
          eligibleShots.map((s) => s.shotId),
        ),
      );

    const sceneById = new Map<string, { id: string; episodeId: string }>();
    for (const row of sceneRows) {
      if (typeof row.id === "string" && typeof row.episodeId === "string") {
        sceneById.set(row.id, { id: row.id, episodeId: row.episodeId });
      }
    }
    const shotById = new Map<string, { id: string; sceneId: string; prompt: string | null }>();
    for (const row of shotRows) {
      if (
        typeof row.id === "string" &&
        typeof row.sceneId === "string" &&
        (row.prompt === null || typeof row.prompt === "string")
      ) {
        shotById.set(row.id, { id: row.id, sceneId: row.sceneId, prompt: row.prompt });
      }
    }

    // 6-8. Concurrency-safe acceptance window: the dedup read, the job
    //      inserts, and the payload-tracking write all happen while the
    //      plan's row lock is held. The FIRST statement inside the
    //      transaction is the locking SELECT (the repository's
    //      `completeJobWithAssetVersion` pattern), so a concurrent request
    //      for the same plan serializes here instead of racing the
    //      check-then-insert window.
    const created: PlanGenerationJobRef[] = [];
    const alreadyActive: PlanGenerationJobRef[] = [];
    const failed: PlanGenerationItemFailure[] = [];

    await getDb().transaction(async (tx: PlanGenerationTx) => {
      // 6a. Lock the plan row. A concurrent generate for the SAME plan
      //     blocks here until the first transaction commits; a generate
      //     for a DIFFERENT plan takes a different row lock and proceeds.
      const lockRows = await tx
        .select({ id: productionPlans.id })
        .from(productionPlans)
        .where(
          and(
            eq(productionPlans.id, input.productionPlanId),
            eq(productionPlans.projectId, input.projectId),
          ),
        )
        .for("update");
      if (lockRows.length === 0) {
        throw new PlanGenerationError("Production plan not found", 404);
      }

      // 6b. Re-check the approval gate under the lock: a plan cancelled or
      //     reset while this request was starting is refused before any
      //     write. The lock guarantees no other writer can flip it back
      //     mid-request (approved is terminal in the C7.1 state machine,
      //     and the generate flow itself never writes plan.status).
      const [lockedPlan] = await tx
        .select({ status: productionPlans.status, plan: productionPlans.plan })
        .from(productionPlans)
        .where(eq(productionPlans.id, input.productionPlanId));
      if (!lockedPlan || (lockedPlan.status as string) !== GENERATION_ALLOWED_STATUS) {
        throw new PlanGenerationError(
          `Media generation can only start from an approved production plan (current status: "${lockedPlan?.status ?? "unknown"}").`,
          409,
        );
      }

      // 6c. Fresh dedup read inside the lock — this is what closes the
      //     race: any job committed by the previous lock holder is visible
      //     here, so the loser reports `alreadyActive` instead of
      //     double-creating.
      const activeJobByShotId = await this.findActiveJobsForShots(
        tx,
        eligibleShots.map((s) => s.shotId),
        input.productionPlanId,
      );

      // 7. Per-shot acceptance: every tracked shot is validated and
      //    accepted (or rejected) independently — partial outcomes keep
      //    what worked.
      for (const { sceneId, shotId } of eligibleShots) {
        const scene = sceneById.get(sceneId);
        const shot = shotById.get(shotId);

        // Structural references first: tracked rows that no longer exist
        // or no longer hang off the plan's episode are per-shot failures,
        // never silent generation or a request-level abort.
        if (!scene || scene.episodeId !== episodeId) {
          failed.push({
            sceneId,
            shotId,
            reason: "The tracked scene no longer exists in the plan's episode.",
          });
          continue;
        }
        if (!shot || shot.sceneId !== sceneId) {
          failed.push({
            sceneId,
            shotId,
            reason: "The tracked shot no longer exists in its scene.",
          });
          continue;
        }

        // Required production data: the shot must carry a media prompt
        // (the C7.6 output, or a hand-authored one on a tracked shot).
        if (shot.prompt === null || shot.prompt.trim().length === 0) {
          failed.push({
            sceneId,
            shotId,
            reason: "The tracked shot has no media prompt to generate from.",
          });
          continue;
        }

        // Duplicate submission: this plan already has in-flight work for
        // the shot — report it instead of creating a second job.
        const activeJob = activeJobByShotId.get(shotId);
        if (activeJob) {
          alreadyActive.push({
            sceneId,
            shotId,
            jobId: activeJob.id,
            status: activeJob.status as JobStatus,
          });
          continue;
        }

        // Job creation through the EXISTING C6 service: full ownership
        // validation, capability/job-type checks and C6.8.2 automatic
        // provider/model routing. No provider is ever contacted here; the
        // job stays `queued` for the existing executor. The insert runs on
        // the pool (createJob's own handle) and completes BEFORE the lock
        // is released, so serialized waiters observe it committed.
        try {
          const job = await generationJobService.createJob({
            projectId: input.projectId,
            jobType: PLAN_GENERATION_JOB_TYPE,
            episodeId,
            sceneId,
            shotId,
            prompt: shot.prompt,
            targetMediaType: "video",
            metadata: {
              productionPlanId: input.productionPlanId,
              source: "production-plan",
            },
          });
          if (!job) {
            failed.push({
              sceneId,
              shotId,
              reason: "Generation job creation failed.",
            });
            continue;
          }
          created.push({ sceneId, shotId, jobId: job.id, status: job.status as JobStatus });
        } catch (error) {
          failed.push({
            sceneId,
            shotId,
            reason: error instanceof Error ? error.message : "Generation job creation failed.",
          });
        }
      }

      // 7b. Payload tracking: append the newly created job ids to the
      //     plan's `generatedJobIds`, merged over the FRESHEST payload
      //     (re-read under the lock, so a payload edited between step 1
      //     and the lock is preserved) — the same merge-preserving
      //     convention the C7 services use for their tracking keys.
      if (created.length > 0) {
        const current = isPlainObject(lockedPlan.plan) ? lockedPlan.plan : {};
        const nextPlan = this.withGeneratedJobTracking(
          current,
          created.map((c) => c.jobId),
        );
        await tx
          .update(productionPlans)
          .set({ plan: nextPlan })
          .where(eq(productionPlans.id, input.productionPlanId));
      }
    });

    // 8. Aggregate report. `completed` only when every eligible shot was
    //    accepted (created or already active); `partial` when some were;
    //    `failed` when none were. Already-created work is always reported.
    const accepted = created.length + alreadyActive.length;
    let reportStatus: PlanGenerationReportStatus;
    if (failed.length === 0) {
      reportStatus = "completed";
    } else if (accepted > 0) {
      reportStatus = "partial";
    } else {
      reportStatus = "failed";
    }

    return {
      productionPlanId: input.productionPlanId,
      status: reportStatus,
      jobType: PLAN_GENERATION_JOB_TYPE,
      created,
      alreadyActive,
      failed,
    };
  }

  /**
   * Extracts the tracked shot ids per scene from the plan payload's
   * `shotIds` map (scene id → string[]), with the same defensive filtering
   * the C7.5/C7.7 extraction helpers apply. A scene recorded without
   * tracked ids contributes no eligible shots.
   */
  private extractTrackedShotIdsByScene(plan: unknown): Record<string, string[]> {
    if (!isPlainObject(plan)) return {};
    const raw = plan.shotIds;
    if (!isPlainObject(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [sceneId, ids] of Object.entries(raw)) {
      if (sceneId.length === 0 || !Array.isArray(ids)) continue;
      const tracked = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (tracked.length > 0) out[sceneId] = tracked;
    }
    return out;
  }

  /**
   * Extracts the generation-job ids this plan has recorded in its payload's
   * flat `generatedJobIds` key. Anything that is not a non-empty string is
   * ignored, so a corrupted list can never leak into a report. Public so
   * tests (and a future UI) share one definition of the tracking key.
   */
  extractGeneratedJobIds(plan: unknown): string[] {
    if (!isPlainObject(plan)) return [];
    const raw = plan[PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  /**
   * Merges newly created job ids into the plan payload's `generatedJobIds`
   * list, preserving every unrelated key — including the story, episode/
   * script references, scene/shot tracking, promptedShotIds, and any user
   * payload keys. Idempotent: an already-tracked id keeps its position and
   * is never duplicated (the append-only rule records every job ever
   * initiated from this plan; status stays in `ai_jobs`).
   */
  private withGeneratedJobTracking(
    plan: Record<string, unknown>,
    jobIds: string[],
  ): Record<string, unknown> {
    const tracked = this.extractGeneratedJobIds(plan);
    const next = [...tracked];
    for (const id of jobIds) {
      if (!next.includes(id)) next.push(id);
    }
    return { ...plan, [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: next };
  }

  /**
   * Finds this plan's still-active (non-terminal) generation jobs for the
   * given shots, scoped to jobs the plan itself created, using the given
   * (transaction) handle so the read observes every job committed by the
   * previous lock holder. Uses the existing `ai_jobs.metadata` JSON column
   * — no schema change. Terminal jobs are excluded so finished/failed/
   * cancelled work never blocks re-generation.
   */
  private async findActiveJobsForShots(
    tx: PlanGenerationTx,
    shotIds: string[],
    productionPlanId: string,
  ): Promise<Map<string, { id: string; status: string }>> {
    const activeByShotId = new Map<string, { id: string; status: string }>();
    if (shotIds.length === 0) return activeByShotId;
    const rows = await tx
      .select({
        id: aiJobs.id,
        shotId: aiJobs.shotId,
        status: aiJobs.status,
        jobType: aiJobs.jobType,
        metadata: aiJobs.metadata,
      })
      .from(aiJobs)
      .where(and(inArray(aiJobs.shotId, shotIds), inArray(aiJobs.status, [...ACTIVE_JOB_STATUSES])));

    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.shotId !== "string") continue;
      if (row.jobType !== PLAN_GENERATION_JOB_TYPE) continue;
      // Only jobs this plan created count toward its duplicate-submission
      // guard; a manual C6 job on the same shot is the user's own work.
      const metadata = isPlainObject(row.metadata) ? row.metadata : null;
      if (metadata?.productionPlanId !== productionPlanId) continue;
      if (!activeByShotId.has(row.shotId)) {
        activeByShotId.set(row.shotId, { id: row.id, status: String(row.status ?? "") });
      }
    }
    return activeByShotId;
  }
}

export const planGenerationService = new PlanGenerationService();
