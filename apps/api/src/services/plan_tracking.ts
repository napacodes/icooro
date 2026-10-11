import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { scenes } from "../db/schema/scenes.js";
import { episodes } from "../db/schema/episodes.js";
import { shots } from "../db/schema/shots.js";
import {
  PLAN_GENERATION_JOB_TYPE,
  PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY,
  type PlanTrackingRecord,
  type PlanTrackingReport,
  type PlanTrackingRecordState,
  type PlanTrackingRecordStatus,
} from "@icooro/shared";
import { assets } from "../db/schema/assets.js";
import { assetVersions } from "../db/schema/asset_versions.js";
import { aiJobs } from "../db/schema/ai_jobs.js";
import { productionPlanService } from "./production_plan.js";
import { planGenerationService } from "./plan_generation.js";
import { sceneGenerationService } from "./scene_generation.js";

/**
 * C8.3 — Read-only execution tracking for plan-generated jobs.
 *
 * GET /projects/:projectId/production-plans/:id/execution
 *
 * Reports the CURRENT PERSISTED STATE of the generation jobs the C8.1
 * entry point created from this plan (its `generatedJobIds` payload
 * tracking) — for a UI that must show progress without ever touching the
 * execution machinery. The service is deliberately incapable of side
 * effects: it performs no writes, invokes no executor, polls no provider,
 * downloads nothing, and never changes the plan or any job row. Provider
 * submission, polling, downloading, and asset-version creation remain the
 * existing C5/C6 lifecycle's responsibility, exactly as C8.2 left them.
 *
 * What it reuses (and what it deliberately does not reinvent):
 * - `productionPlanService.getPlan` — project-scoped plan lookup, so a
 *   plan from another project is an indistinguishable 404 (the route's
 *   standard ownership block handles the project half).
 * - `sceneGenerationService.extractSceneIdsFromPlan` — the plan's
 *   authoritative tracked-scene set (`sceneIds`): the same payload the
 *   C7.4–C7.5 generators wrote and C8.2 verifies against, with the same
 *   fail-closed membership semantics (no secondary derivation).
 * - `planGenerationService.extractGeneratedJobIds` — the durable C8.1
 *   body, and the payload list is the only source of truth. An
 *   empty/absent list is the `empty` report state (not an error): C8.1's
 *   `/generate` creates the work, and a plan that has not started
 *   generation legitimately tracks nothing yet.
 * - The real `ai_jobs` lifecycle vocabulary: statuses are read as stored
 *   and reported through the existing queued/submitted/processing/
 *   downloading + completed/failed/cancelled states — no new statuses,
 *   no state copied into the plan, no inference from progress values.
 * - The existing job→asset-version and asset-version→asset links written
 *   by `completeJobWithAssetVersion` during `POST /jobs/:id/persist-result`.
 *   A completed output is exposed ONLY when the job's status is actually
 *   `completed` AND those real, persisted, project-consistent links are
 *   consistent — never synthesized from job status alone, never from
 *   asset references an active/in-progress row happens to carry, and
 *   never an invented URL.
 *
 * Per-record safety (the C8.2 conventions, applied to reads):
 * - A tracked id that no longer resolves → `missing` record with a safe
 *   reason that reveals nothing about other rows.
 * - A row whose project, plan provenance (`metadata.productionPlanId`), or
 *   job type no longer matches the plan's context → `invalid` record, read
 *   but never trusted.
 * - Relationship verification (the C8.2 `verifyShotRelationships` pattern,
 *   adapted to reads and BATCHED): the job's shot→scene→episode→project
 *   chain must resolve, and the job's scene must be one the plan's
 *   authoritative `sceneIds` tracks. Failures of EITHER kind are
 *   fail-closed: the record becomes `invalid`, and its shot/scene context
 *   AND any output link are withheld — no foreign scene, shot or project
 *   identifier can leak through the report.
 * - Unknown status values are bucketed as `invalid` instead of guessed.
 *
 * Efficiency: the tracked ids are resolved with ONE batched
 * `inArray(aiJobs.id, ...)` read (plus one batched asset-versions read and
 * one batched assets read for completed outputs) — no N+1 per-job queries.
 *
 * Ordering: records keep the plan's `generatedJobIds` order — the stable,
 * deterministic order C8.1 established — so repeated GETs and refreshes
 * render identically.
 */

/** ai_jobs statuses that mean the tracked work still exists (non-terminal). */
const ACTIVE_TRACKING_STATUSES: readonly string[] = [
  "queued",
  "submitted",
  "processing",
  "downloading",
];

/** ai_jobs statuses that are terminal. */
const TERMINAL_TRACKING_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

/** Every lifecycle status the shared contract knows (for safe reporting). */
const KNOWN_JOB_STATUSES: readonly string[] = [
  ...ACTIVE_TRACKING_STATUSES,
  ...TERMINAL_TRACKING_STATUSES,
];

export class PlanTrackingError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "PlanTrackingError";
    this.status = status;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface TrackPlanExecutionInput {
  projectId: string;
  productionPlanId: string;
}

export class PlanTrackingService {
  /**
   * Builds the current tracking report for one plan's generated jobs.
   * Ownership is enforced by the caller (the route's standard C7.1
   * project-ownership block); the plan lookup here is scoped to the
   * project, so a plan from another project is a 404 by construction.
   */
  async trackExecution(input: TrackPlanExecutionInput): Promise<PlanTrackingReport> {
    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const plan = await productionPlanService.getPlan(input.productionPlanId, input.projectId);
    if (!plan) {
      throw new PlanTrackingError("Production plan not found", 404);
    }

    // 2. The durable C8.1 tracking list — never caller-supplied ids (a GET
    //    has no body anyway, and the payload is the single provenance
    //    source). An empty/absent list is not an error: a plan that has
    //    not started media generation legitimately tracks nothing.
    const trackedJobIds = planGenerationService.extractGeneratedJobIds(plan.plan);

    const records: PlanTrackingRecord[] = trackedJobIds.map((jobId) => ({
      jobId,
      recordState: "missing",
      status: null,
      progress: null,
      shotId: null,
      sceneId: null,
      output: null,
      error: null,
      updatedAt: null,
    }));

    // 3. Batched resolution of every tracked id at once — no N+1. One
    //    round trip fetches all rows; per-record classification happens
    //    below against this single snapshot.
    const jobRows = trackedJobIds.length
      ? await getDb()
          .select({
            id: aiJobs.id,
            jobType: aiJobs.jobType,
            status: aiJobs.status,
            projectId: aiJobs.projectId,
            episodeId: aiJobs.episodeId,
            sceneId: aiJobs.sceneId,
            shotId: aiJobs.shotId,
            assetId: aiJobs.assetId,
            assetVersionId: aiJobs.assetVersionId,
            progress: aiJobs.progress,
            error: aiJobs.error,
            metadata: aiJobs.metadata,
            updatedAt: aiJobs.updatedAt,
          })
          .from(aiJobs)
          .where(inArray(aiJobs.id, trackedJobIds))
      : [];

    const jobById = new Map<string, (typeof jobRows)[number]>();
    for (const row of jobRows) {
      if (typeof row.id === "string") jobById.set(row.id, row);
    }

    // 3b. Provenance pass — classify which rows are context-valid BEFORE
    //     the hierarchy reads, so those reads only ever touch the shots and
    //     scenes a plan's own jobs may legitimately reference. Foreign rows
    //     stay unloaded, and their identity stays unexposed.
    const contextValidRows: Array<{ jobId: string; shotId: unknown; sceneId: unknown }> = [];
    const shotsToRead = new Set<string>();
    const scenesToRead = new Set<string>();
    let anchoredEpisodeId: string | null = null;

    const payload = isPlainObject(plan.plan) ? plan.plan : {};
    // The plan's authoritative tracked-scene set (C7.4) and episode anchor
    // (plan row first, payload fallback — the C7.3–C7.6 precedence C8.2 and
    // plan generation both use).
    const trackedSceneIds = new Set(sceneGenerationService.extractSceneIdsFromPlan(plan.plan));
    const hasTrackedScenes = trackedSceneIds.size > 0;
    anchoredEpisodeId =
      typeof plan.episodeId === "string"
        ? plan.episodeId
        : typeof payload.episodeId === "string"
          ? payload.episodeId
          : null;

    for (const jobId of trackedJobIds) {
      const job = jobById.get(jobId);
      if (!job) continue;
      const metadata = isPlainObject(job.metadata) ? job.metadata : null;
      if (
        job.projectId === input.projectId &&
        job.jobType === PLAN_GENERATION_JOB_TYPE &&
        metadata?.productionPlanId === input.productionPlanId
      ) {
        contextValidRows.push({ jobId, shotId: job.shotId, sceneId: job.sceneId });
        if (typeof job.shotId === "string" && job.shotId.length > 0) shotsToRead.add(job.shotId);
        if (typeof job.sceneId === "string" && job.sceneId.length > 0) scenesToRead.add(job.sceneId);
      }
    }

    // 3c. Batched relationship reads — adapted from the C8.2
    //     `verifyShotRelationships` inputs: every referenced shot row, every
    //     referenced scene row (ONE query each), plus the plan's anchored
    //     episode within the requested project. Per-record verification
    //     happens below against these maps — no N+1.
    const shotRowMap = new Map<string, { id: string; sceneId: string }>();
    const sceneRowMap = new Map<string, { id: string; episodeId: string }>();
    let episodeRow: { id: string } | null = null;

    if (shotsToRead.size > 0) {
      const rows = await getDb()
        .select({ id: shots.id, sceneId: shots.sceneId })
        .from(shots)
        .where(inArray(shots.id, [...shotsToRead]));
      for (const row of rows) {
        if (typeof row.id === "string" && typeof row.sceneId === "string") {
          shotRowMap.set(row.id, row);
        }
      }
    }
    if (scenesToRead.size > 0) {
      const rows = await getDb()
        .select({ id: scenes.id, episodeId: scenes.episodeId })
        .from(scenes)
        .where(inArray(scenes.id, [...scenesToRead]));
      for (const row of rows) {
        if (typeof row.id === "string" && typeof row.episodeId === "string") {
          sceneRowMap.set(row.id, row);
        }
      }
    }
    if (anchoredEpisodeId) {
      const [row] = await getDb()
        .select({ id: episodes.id })
        .from(episodes)
        .where(and(eq(episodes.id, anchoredEpisodeId), eq(episodes.projectId, input.projectId)));
      episodeRow = row && typeof row.id === "string" ? row : null;
    }

    /**
     * Fail-closed relationship verification for one context-valid job —
     * the C8.2 checks in the same order, with the same reasons: shot must
     * exist, belong to the job's recorded scene; the scene must exist and
     * sit in the plan's anchored episode in this project; the scene must
     * be one the plan's authoritative `sceneIds` tracks (a payload without
     * that set can NEVER prove membership — no secondary derivation).
     * Returns a relationship-specific, non-leaking reason.
     */
    const relationshipFailure = (
      shotId: unknown,
      sceneId: unknown,
      jobEpisodeId: unknown,
    ): { ok: true } | { ok: false; reason: string } => {
      if (!anchoredEpisodeId) {
        return {
          ok: false,
          reason:
            "The production plan is not anchored to an episode, so its tracked jobs cannot be verified.",
        };
      }
      if (
        typeof shotId !== "string" ||
        shotId.length === 0 ||
        typeof sceneId !== "string" ||
        sceneId.length === 0
      ) {
        return { ok: false, reason: "The tracked job has no verifiable shot/scene reference." };
      }
      const shotRow = shotRowMap.get(shotId);
      if (!shotRow) {
        return { ok: false, reason: "The tracked job's shot no longer exists." };
      }
      if (shotRow.sceneId !== sceneId) {
        return {
          ok: false,
          reason: "The tracked job's shot no longer belongs to its recorded scene.",
        };
      }
      const sceneRow = sceneRowMap.get(sceneId);
      if (!sceneRow) {
        return {
          ok: false,
          reason:
            "The tracked job's scene no longer belongs to the production plan's episode and project.",
        };
      }
      if (!episodeRow || sceneRow.episodeId !== anchoredEpisodeId) {
        return {
          ok: false,
          reason:
            "The tracked job's scene no longer belongs to the production plan's episode and project.",
        };
      }
      // The job's OWN recorded episode must also agree — fail closed on a
      // missing, malformed or inconsistent reference. A row whose episode
      // disagrees with the otherwise valid shot→scene chain cannot prove
      // where it belongs, so nothing of it is trusted beyond its status.
      if (
        typeof jobEpisodeId !== "string" ||
        jobEpisodeId.length === 0 ||
        jobEpisodeId !== sceneRow.episodeId ||
        jobEpisodeId !== anchoredEpisodeId
      ) {
        return {
          ok: false,
          reason:
            "The tracked job's recorded episode no longer matches the production plan's episode.",
        };
      }
      if (!hasTrackedScenes) {
        return {
          ok: false,
          reason:
            "The production plan's payload does not record the tracked scene set this job must belong to.",
        };
      }
      if (!trackedSceneIds.has(sceneId)) {
        return {
          ok: false,
          reason: "The tracked job's scene is not tracked by this production plan.",
        };
      }
      return { ok: true };
    };

    // 4. Per-record classification. Each tracked id is judged
    //    independently, exactly like the C8.2 per-job handling: one
    //    malformed record never affects its neighbours.
    const recordsWithOutputLinks: PlanTrackingRecord[] = [];
    for (let index = 0; index < trackedJobIds.length; index++) {
      const jobId = trackedJobIds[index]!;
      const record = records[index]!;
      const job = jobById.get(jobId);

      if (!job) {
        record.recordState = "missing";
        record.reason = "The tracked generation job no longer exists.";
        continue;
      }

      // Context verification — the same provenance checks C8.2 applies
      // before trusting a row (project, plan metadata, job type), now
      // used to decide how much of the row may be reported.
      const metadata = isPlainObject(job.metadata) ? job.metadata : null;
      const contextOk =
        job.projectId === input.projectId &&
        job.jobType === PLAN_GENERATION_JOB_TYPE &&
        metadata?.productionPlanId === input.productionPlanId;
      if (!contextOk) {
        record.recordState = "invalid";
        record.reason =
          "The tracked job no longer belongs to this production plan's context.";
        // C8.2's context-mismatch convention: the lifecycle status is
        // reported, but no shot/scene context of the mismatched row is.
        record.status = KNOWN_JOB_STATUSES.includes(job.status as string)
          ? (job.status as PlanTrackingRecordStatus)
          : null;
        continue;
      }

      // Unknown status values are reported, never guessed into a state.
      const status = typeof job.status === "string" ? job.status : "";
      if (
        !ACTIVE_TRACKING_STATUSES.includes(status) &&
        !TERMINAL_TRACKING_STATUSES.includes(status)
      ) {
        record.recordState = "invalid";
        record.reason = `The tracked job is in unsupported status "${status}".`;
        record.status = null;
        continue;
      }

      // Relationship verification (fail closed): a broken shot→scene→
      // episode→project chain, or a scene outside the plan's tracked
      // `sceneIds`, withholds the record's context and output. C8.2's
      // skip convention: the lifecycle status is still reported, the
      // shot/scene of the unverified row is not, and the reason says why.
      const relationships = relationshipFailure(job.shotId, job.sceneId, job.episodeId);
      if (!relationships.ok) {
        record.recordState = "invalid";
        record.reason = relationships.reason;
        record.status = status as PlanTrackingRecordStatus;
        continue;
      }

      const jobStatus = status as PlanTrackingRecordStatus;
      const isActive = ACTIVE_TRACKING_STATUSES.includes(status);
      record.recordState = isActive ? "active" : "terminal";
      record.status = jobStatus;
      record.progress = typeof job.progress === "number" ? job.progress : null;
      record.shotId = typeof job.shotId === "string" ? job.shotId : null;
      record.sceneId = typeof job.sceneId === "string" ? job.sceneId : null;
      record.error =
        !isActive && jobStatus === "failed" && typeof job.error === "string" && job.error.length > 0
          ? job.error
          : null;
      record.updatedAt = job.updatedAt instanceof Date ? job.updatedAt.toISOString() : null;

      // Output links are collected for batched verification — and only
      // from COMPLETED jobs. An active row that happens to carry asset
      // references (never written by `completeJobWithAssetVersion`, but
      // never ruled out by the schema) is never treated as having an
      // output. The record itself is filled in below once the linked rows
      // are proven consistent.
      if (jobStatus === "completed" && job.assetVersionId && job.assetId) {
        recordsWithOutputLinks.push(record);
      }
    }

    // 5. Completed outputs: resolve the REAL job→asset-version→asset
    //    links in TWO batched reads (asset_versions by id, then assets by
    //    id). The link is exposed only when the version row exists, is the
    //    one the job points at, belongs to the job's asset, and that asset
    //    belongs to the requesting project — the persisted output exactly
    //    as `completeJobWithAssetVersion` wrote it. Anything else stays
    //    null: no URL is invented, and success is never inferred from
    //    status alone.
    if (recordsWithOutputLinks.length > 0) {
      const versionIds = [
        ...new Set(
          recordsWithOutputLinks.map((r) => jobById.get(r.jobId)?.assetVersionId as string),
        ),
      ];
      const assetIds = [
        ...new Set(recordsWithOutputLinks.map((r) => jobById.get(r.jobId)?.assetId as string)),
      ];

      const [versionRows, assetRows] = await Promise.all([
        getDb()
          .select({
            id: assetVersions.id,
            assetId: assetVersions.assetId,
            version: assetVersions.version,
            status: assetVersions.status,
            mimeType: assetVersions.mimeType,
            fileSize: assetVersions.fileSize,
          })
          .from(assetVersions)
          .where(inArray(assetVersions.id, versionIds)),
        getDb()
          .select({ id: assets.id, projectId: assets.projectId, name: assets.name, type: assets.type })
          .from(assets)
          .where(inArray(assets.id, assetIds)),
      ]);

      const versionById = new Map<string, (typeof versionRows)[number]>();
      for (const row of versionRows) {
        if (typeof row.id === "string") versionById.set(row.id, row);
      }
      const assetById = new Map<string, (typeof assetRows)[number]>();
      for (const row of assetRows) {
        if (typeof row.id === "string") assetById.set(row.id, row);
      }

      for (const record of recordsWithOutputLinks) {
        const job = jobById.get(record.jobId)!;
        const assetVersionId = job.assetVersionId as string;
        const assetId = job.assetId as string;
        const versionRow = versionById.get(assetVersionId);
        const assetRow = assetById.get(assetId);

        if (
          !versionRow ||
          !assetRow ||
          versionRow.assetId !== assetId ||
          assetRow.projectId !== input.projectId
        ) {
          // Broken or cross-project link: report the job without an
          // output rather than a fabricated or unowned one.
          continue;
        }

        record.output = {
          assetVersionId,
          assetId,
          assetName: typeof assetRow.name === "string" ? assetRow.name : "",
          assetType: typeof assetRow.type === "string" ? assetRow.type : "",
          version: typeof versionRow.version === "number" ? versionRow.version : 0,
          mimeType: typeof versionRow.mimeType === "string" ? versionRow.mimeType : null,
          fileSize: typeof versionRow.fileSize === "number" ? versionRow.fileSize : null,
          status: typeof versionRow.status === "string" ? versionRow.status : "",
        };
      }
    }

    // 6. Aggregate status (presentation-level, derived from the records):
    //    any active work → "active"; else any completed output →
    //    "completed"; else any terminal failure → "failed"; else —
    //    including an empty tracking list — "empty".
    const counts = {
      total: records.length,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      missing: 0,
      invalid: 0,
    };
    for (const record of records) {
      if (record.recordState === "active") counts.active += 1;
      else if (record.recordState === "missing") counts.missing += 1;
      else if (record.recordState === "invalid") counts.invalid += 1;
      else if (record.status === "completed") counts.completed += 1;
      else if (record.status === "failed") counts.failed += 1;
      else if (record.status === "cancelled") counts.cancelled += 1;
    }

    let reportStatus: PlanTrackingReport["status"];
    if (counts.active > 0) {
      reportStatus = "active";
    } else if (counts.completed > 0) {
      reportStatus = "completed";
    } else if (counts.failed > 0 || counts.cancelled > 0) {
      reportStatus = "failed";
    } else {
      reportStatus = "empty";
    }

    return {
      productionPlanId: input.productionPlanId,
      status: reportStatus,
      jobType: PLAN_GENERATION_JOB_TYPE,
      records,
      counts,
    };
  }
}

export const planTrackingService = new PlanTrackingService();
