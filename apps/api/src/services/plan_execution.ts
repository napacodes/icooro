import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  PLAN_GENERATION_JOB_TYPE,
  type JobStatus,
  type PlanExecutionItem,
  type PlanExecutionOutcome,
  type PlanExecutionReport,
  type PlanExecutionReportStatus,
} from "@icooro/shared";
import { generationExecutorService } from "./generation_executor.js";
import {
  ExecutorConfigError,
  ExecutorInvalidStateError,
  ExecutorJobNotFoundError,
} from "./generation_executor.js";
import { generationJobService } from "./generation.js";
import { planGenerationService } from "./plan_generation.js";
import { productionPlanService } from "./production_plan.js";
import { sceneGenerationService } from "./scene_generation.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { episodes } from "../db/schema/episodes.js";

/**
 * C8.2 — Execution initiation for plan-generated jobs.
 *
 * POST /projects/:projectId/production-plans/:id/execute
 *
 * C8.1 created queued `ai_jobs` rows for an approved plan's tracked shots
 * and recorded their ids in the plan payload's `generatedJobIds`. This
 * endpoint initiates execution of those EXISTING jobs by handing them to
 * the existing C5.2 generation executor (`GenerationExecutorService.
 * submitJob`) — it creates no jobs, calls no provider, runs no polling and
 * persists no results itself. Polling, downloading, and asset-version
 * creation remain the existing lifecycle's responsibility
 * (`POST /jobs/:id/poll`, `POST /jobs/:id/persist-result`).
 *
 * What it reuses (and what it deliberately does not reinvent):
 * - `planGenerationService.extractGeneratedJobIds` — the durable C8.1
 *   payload tracking key. Job ids are NEVER accepted from the caller; a
 *   request body cannot make this endpoint execute arbitrary jobs.
 * - `generationJobService.getJob` — resolves each tracked id to its row.
 *   It loads the `ai_jobs` record by id only; relationship verification
 *   (project, plan provenance, job type, and the shot/scene chain below)
 *   happens here, in this service, before anything is submitted.
 * - `GenerationExecutorService.submitJob` — the real submission path with
 *   its provider/model configuration checks, `resolveVideoProvider`
 *   capability resolution, `safeErrorMessage` sanitization, the
 *   queued-status state check, and the in-process concurrent-submission
 *   guard (`submissionsInFlight`). Provider errors are converted by the
 *   executor itself into a `failed` job row — this service reports that
 *   outcome without re-deriving it.
 *
 * Job selection and status semantics (the real `ai_jobs` lifecycle):
 * - `queued` → relationship-verified, then submitted through the executor
 *   (queued → submitted, or queued → failed on provider error; both
 *   reported accurately). Verification pins the shot→scene→episode→
 *   project chain and the plan's tracked `sceneIds`: a shot that no
 *   longer exists, moved scene, or a scene the plan does not track is a
 *   skip, never a submission. Scene membership is enforced FAIL CLOSED:
 *   C7.4 records the tracked generated-scene set in the plan payload
 *   (`sceneIds`) and C7.5/C8.1 merge it forward, so a payload without it
 *   cannot prove the membership and the job is skipped — the tracked-set
 *   id plus chain checks above are never waved through on an unverifiable
 *   reference.
 * - `submitted` / `processing` / `downloading` → already active, NOT
 *   resubmitted. The executor's own state check and in-flight guard are
 *   the authoritative backstop: an `ExecutorInvalidStateError` from a race
 *   (job moved between the read and the submit) is reported as
 *   already-active, never as a failure.
 * - `completed` / `failed` / `cancelled` → skipped. Terminal jobs are
 *   never silently treated as active and never auto-regenerated here
 *   (C8.1's `/generate` is the only path that creates replacement work).
 * - A tracked id that no longer resolves to a job row → skipped, with a
 *   reason that reveals nothing about other records.
 *
 * Concurrency posture (unchanged, honestly stated): the executor's
 * duplicate-submission protection is the queued-status check plus an
 * in-process guard — the same guarantees the standalone
 * `POST /jobs/:id/submit` endpoint has always had. Two concurrent plan
 * executions in one process cannot double-submit a job; multi-instance
 * deployments were never protected by that guard and this endpoint does
 * not pretend otherwise.
 */

/** The only plan status from which execution may be initiated. */
const EXECUTION_ALLOWED_STATUS = "approved";

/** ai_jobs statuses that mean the job is already in flight. */
const IN_FLIGHT_STATUSES: readonly string[] = ["submitted", "processing", "downloading"];

/** ai_jobs statuses that are terminal and therefore never resubmitted. */
const TERMINAL_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

export class PlanExecutionError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "PlanExecutionError";
    this.status = status;
  }
}

function item(
  jobId: string,
  outcome: PlanExecutionOutcome,
  context: { shotId: string | null; sceneId: string | null; status: JobStatus | null },
  reason?: string,
): PlanExecutionItem {
  return reason === undefined
    ? { jobId, shotId: context.shotId, sceneId: context.sceneId, status: context.status, outcome }
    : { jobId, shotId: context.shotId, sceneId: context.sceneId, status: context.status, outcome, reason };
}

export interface ExecutePlanInput {
  projectId: string;
  productionPlanId: string;
}

export class PlanExecutionService {
  /**
   * Initiates execution for the generation jobs the C8.1 entry point
   * created from an APPROVED production plan. Ownership is enforced by the
   * caller (the route's standard C7.1 project-ownership block); the plan
   * lookup here is scoped to the project, so a plan from another project
   * is a 404 by construction.
   */
  async executePlan(input: ExecutePlanInput): Promise<PlanExecutionReport> {
    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const plan = await productionPlanService.getPlan(input.productionPlanId, input.projectId);
    if (!plan) {
      throw new PlanExecutionError("Production plan not found", 404);
    }

    // 2. Approval gate: execution starts only from an APPROVED plan. The
    //    status is never changed here (approved is terminal and stays so).
    if ((plan.status as string) !== EXECUTION_ALLOWED_STATUS) {
      throw new PlanExecutionError(
        `Execution can only start from an approved production plan (current status: "${plan.status}"). Move the plan through review and approval first.`,
        409,
      );
    }

    // 3. Resolve the jobs from the DURABLE C8.1 tracking field — never from
    //    caller-supplied ids. An empty/absent list is a per-request 400:
    //    there is nothing tracked to execute (C8.1's /generate creates the
    //    work; this endpoint never invents it).
    const trackedJobIds = planGenerationService.extractGeneratedJobIds(plan.plan);
    if (trackedJobIds.length === 0) {
      throw new PlanExecutionError(
        "This production plan has no tracked generation jobs to execute. Start media generation first (POST .../generate).",
        400,
      );
    }

    // 3b. The plan's tracked generated-scene ids (C7.4 payload convention).
    //     A tracked job's shot must sit inside one of these scenes, so a
    //     job whose shot was moved to an untracked scene cannot ride a
    //     stale payload id into the executor.
    const trackedSceneIds = new Set(
      sceneGenerationService.extractSceneIdsFromPlan(plan.plan),
    );
    // Fail-closed flag: whether the payload records a tracked-scene set at
    // all. Without it, membership can never be proven (see step 5 of
    // `verifyShotRelationships`).
    const hasTrackedScenes = trackedSceneIds.size > 0;

    const submitted: PlanExecutionItem[] = [];
    const alreadyActive: PlanExecutionItem[] = [];
    const skipped: PlanExecutionItem[] = [];
    const failed: PlanExecutionItem[] = [];

    // 4. Per-job resolution + initiation. One job's outcome never affects
    //    another's: each tracked id is resolved, context-checked and (when
    //    eligible) submitted independently.
    for (const jobId of trackedJobIds) {
      const job = await generationJobService.getJob(jobId);

      // Tracked id no longer resolves (never created, or deleted since):
      // reported, with no information about other records.
      if (!job) {
        skipped.push(
          item(jobId, "skipped", { shotId: null, sceneId: null, status: null },
            "The tracked generation job no longer exists."),
        );
        continue;
      }

      // Context verification: the row must still belong to the requested
      // project, carry the plan's provenance, and be a plan-generated job
      // of the supported type. (The shot reference itself is verified
      // below, against the actual rows.) A mismatched row is skipped —
      // never executed on the strength of a stale payload id.
      const metadata =
        job.metadata && typeof job.metadata === "object" && !Array.isArray(job.metadata)
          ? (job.metadata as Record<string, unknown>)
          : null;
      const jobSceneId = typeof job.sceneId === "string" ? job.sceneId : null;
      const jobShotId = typeof job.shotId === "string" ? job.shotId : null;
      const contextOk =
        job.projectId === input.projectId &&
        jobShotId !== null &&
        job.jobType === PLAN_GENERATION_JOB_TYPE &&
        metadata?.productionPlanId === input.productionPlanId;
      if (!contextOk) {
        skipped.push(
          item(jobId, "skipped", { shotId: null, sceneId: null, status: job.status as JobStatus },
            "The tracked job no longer belongs to this production plan's context."),
        );
        continue;
      }

      const context = {
        shotId: jobShotId,
        sceneId: jobSceneId,
        status: job.status as JobStatus,
      };

      // 5. Status dispatch on the REAL lifecycle. Already-active and
      //    terminal rows are never handed to the executor.
      if (IN_FLIGHT_STATUSES.includes(job.status as string)) {
        alreadyActive.push(item(jobId, "already_active", context));
        continue;
      }
      if (TERMINAL_STATUSES.includes(job.status as string)) {
        skipped.push(
          item(jobId, "skipped", context,
            `The tracked job is already in terminal status "${job.status}" and will not be regenerated by this endpoint.`),
        );
        continue;
      }
      if (job.status !== "queued") {
        // Unknown status value: report instead of guessing.
        skipped.push(
          item(jobId, "skipped", context,
            `The tracked job is in unsupported status "${job.status}".`),
        );
        continue;
      }

      // 5b. Relationship verification (immediately before submission):
      //     the recorded shot must still exist, belong to the job's
      //     recorded scene, sit inside the plan's anchored episode in the
      //     requested project, and be a scene the plan tracks. Any miss is
      //     a skip — never a submission. Reasons name the relationship that
      //     broke, never the unrelated project or row.
      const relationshipsOk = await this.verifyShotRelationships({
        projectId: input.projectId,
        episodeId: plan.episodeId,
        shotId: jobShotId,
        sceneId: jobSceneId,
        trackedSceneIds,
        hasTrackedScenes,
      });
      if (!relationshipsOk.ok) {
        // No shot/scene context: a broken relationship must not hand the
        // caller (or a foreign scene/project id) back in the report.
        skipped.push(
          item(jobId, "skipped", { shotId: null, sceneId: null, status: job.status as JobStatus },
            relationshipsOk.reason),
        );
        continue;
      }

      // 6. Submit through the EXISTING executor. Its errors map onto the
      //    report without leaking provider internals:
      //    - ExecutorInvalidStateError (queued-status check lost a race, or
      //      the in-flight concurrent-submission guard fired) → the job is
      //      already being handled → already_active.
      //    - ExecutorJobNotFoundError / ExecutorConfigError (provider,
      //      model, prompt, adapter resolution) → failed, reason sanitized
      //      by the executor's own message conventions.
      //    - Any other unexpected error → failed with a generic message so
      //      no internal detail can escape.
      //    A provider-level error is NOT an exception here: the executor
      //    already transitioned the job queued → failed and persisted a
      //    sanitized error, and returns the failed row — reported as
      //    failed with the row's persisted reason.
      try {
        const result = await generationExecutorService.submitJob(jobId);
        if (result && result.status === "submitted") {
          submitted.push(item(jobId, "submitted", { ...context, status: "submitted" }));
        } else if (result && result.status === "failed") {
          failed.push(
            item(jobId, "failed", { ...context, status: "failed" },
              typeof result.error === "string" && result.error.length > 0
                ? result.error
                : "Provider submission failed."),
          );
        } else {
          failed.push(
            item(jobId, "failed", context, "Provider submission failed."),
          );
        }
      } catch (error) {
        if (error instanceof ExecutorInvalidStateError) {
          alreadyActive.push(item(jobId, "already_active", context));
          continue;
        }
        if (error instanceof ExecutorJobNotFoundError) {
          skipped.push(
            item(jobId, "skipped", context, "The tracked generation job no longer exists."),
          );
          continue;
        }
        if (error instanceof ExecutorConfigError) {
          failed.push(item(jobId, "failed", context, error.message));
          continue;
        }
        failed.push(item(jobId, "failed", context, "Job submission failed."));
      }
    }

    // 7. Aggregate. `completed` only when every tracked job was submitted
    //    or is already active; `partial` when some succeeded; `failed`
    //    when none did. Counts are derived from the per-job entries.
    const accepted = submitted.length + alreadyActive.length;
    let reportStatus: PlanExecutionReportStatus;
    if (skipped.length === 0 && failed.length === 0) {
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
      submitted,
      alreadyActive,
      skipped,
      failed,
    };
  }

  /**
   * Verifies the shot→scene→episode→project chain for one tracked job
   * before anything is submitted: the shot row must exist, its scene must
   * match the job's recorded scene, the scene must sit in the plan's
   * anchored episode in the requested project, and the scene must be one
   * the plan tracks (`sceneIds` in its payload). Returns a safe,
   * relationship-specific reason on the first miss; reasons name the
   * broken relationship, never the unrelated project or row.
   */
  private async verifyShotRelationships(input: {
    projectId: string;
    episodeId: string | null;
    shotId: string;
    sceneId: string | null;
    trackedSceneIds: Set<string>;
    /** Whether the payload records a `sceneIds` set at all. */
    hasTrackedScenes: boolean;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    // The plan must be anchored: without an episode there is no chain to
    // verify, and no tracked scene can legitimately live outside one.
    if (typeof input.episodeId !== "string" || input.episodeId.length === 0) {
      return {
        ok: false,
        reason:
          "The production plan is not anchored to an episode, so its tracked jobs cannot be verified.",
      };
    }

    // 1. The referenced shot must still exist.
    const shotRows = await getDb()
      .select({ id: shots.id, sceneId: shots.sceneId })
      .from(shots)
      .where(eq(shots.id, input.shotId));
    const shotRow = shotRows[0];
    if (!shotRow || typeof shotRow.id !== "string" || typeof shotRow.sceneId !== "string") {
      return { ok: false, reason: "The tracked job's shot no longer exists." };
    }

    // 2. The shot must belong to the job's recorded scene.
    if (shotRow.sceneId !== input.sceneId) {
      return {
        ok: false,
        reason: "The tracked job's shot no longer belongs to its recorded scene.",
      };
    }
    const sceneId = input.sceneId as string;

    // 3. The recorded scene must exist and be anchored to the plan's
    //    episode.
    const sceneRows = await getDb()
      .select({ id: scenes.id, episodeId: scenes.episodeId })
      .from(scenes)
      .where(eq(scenes.id, sceneId));
    const sceneRow = sceneRows[0];
    if (!sceneRow || typeof sceneRow.id !== "string" || typeof sceneRow.episodeId !== "string") {
      return {
        ok: false,
        reason:
          "The tracked job's scene no longer belongs to the production plan's episode and project.",
      };
    }

    // 4. The plan's anchored episode must exist in the requested project.
    const episodeRows = await getDb()
      .select({ id: episodes.id })
      .from(episodes)
      .where(and(eq(episodes.id, input.episodeId), eq(episodes.projectId, input.projectId)));
    const episodeRow = episodeRows[0];
    if (!episodeRow || typeof episodeRow.id !== "string") {
      return {
        ok: false,
        reason:
          "The tracked job's scene no longer belongs to the production plan's episode and project.",
      };
    }
    if (sceneRow.episodeId !== input.episodeId) {
      return {
        ok: false,
        reason:
          "The tracked job's scene no longer belongs to the production plan's episode and project.",
      };
    }

    // 5. The scene must be one the plan tracks — FAIL CLOSED. C7.4 writes
    //    the tracked generated-scene set into the payload (`sceneIds`),
    //    C7.5/C8.1 merge it forward, the C7.7 orchestrator only generates
    //    shots inside tracked scenes, and C8.1 only creates jobs for them.
    //    A payload without that set therefore cannot prove the membership
    //    this submission relies on, so the job is skipped — never waved
    //    through on an unverifiable reference. No secondary derivation
    //    (e.g. from the `shotIds` map's keys) is attempted: `sceneIds` is
    //    the contract's authoritative scene-tracking key.
    if (!input.hasTrackedScenes) {
      return {
        ok: false,
        reason:
          "The production plan's payload does not record the tracked scene set this job must belong to.",
      };
    }
    if (!input.trackedSceneIds.has(sceneId)) {
      return {
        ok: false,
        reason: "The tracked job's scene is not tracked by this production plan.",
      };
    }

    return { ok: true };
  }
}

export const planExecutionService = new PlanExecutionService();
