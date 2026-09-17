import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { aiJobs } from "../db/schema/ai_jobs.js";
import { aiProviders } from "../db/schema/ai_providers.js";
import { aiModels } from "../db/schema/ai_models.js";
import { projects } from "../db/schema/projects.js";
import { episodes } from "../db/schema/episodes.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { assets } from "../db/schema/assets.js";
import { assetVersions } from "../db/schema/asset_versions.js";
import type { GenerationJobStatus } from "../providers/types.js";
import { providerRegistry } from "../providers/registry.js";

/**
 * Thrown by `completeJobWithAssetVersion` when a concurrent caller has
 * already linked an AssetVersion to this job. The conditional
 * `WHERE asset_version_id IS NULL` update returned `affectedRows = 0`.
 *
 * This is an internal service-layer error. `generation_result.ts`
 * translates it into the public `ResultAlreadyPersistedError`.
 */
export class JobAlreadyLinkedError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`Job "${jobId}" already has an assetVersionId linked`);
    this.name = "JobAlreadyLinkedError";
    this.jobId = jobId;
  }
}

const VALID_TRANSITIONS: Record<GenerationJobStatus, GenerationJobStatus[]> = {
  queued: ["submitted", "failed", "cancelled"],
  submitted: ["processing", "failed", "cancelled"],
  processing: ["downloading", "completed", "failed", "cancelled"],
  downloading: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isValidJobStatusTransition(
  from: GenerationJobStatus,
  to: GenerationJobStatus,
): boolean {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export interface CreateGenerationJobInput {
  projectId: string;
  jobType: string;
  providerId?: string | null | undefined;
  modelId?: string | null | undefined;
  episodeId?: string | null | undefined;
  sceneId?: string | null | undefined;
  shotId?: string | null | undefined;
  shotVersionId?: string | null | undefined;
  assetId?: string | null | undefined;
  prompt?: string | null | undefined;
  negativePrompt?: string | null | undefined;
  targetMediaType?: string | null | undefined;
  requestedDuration?: number | null | undefined;
  requestedWidth?: number | null | undefined;
  requestedHeight?: number | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export class GenerationJobService {
  /**
   * Validates parent entity hierarchy and ensures that all referenced entities
   * belong to the specified project (strict project isolation).
   */
  async validateOwnership(input: CreateGenerationJobInput): Promise<string | null> {
    const db = getDb();

    // Verify project exists
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    if (!project) return "Project not found";

    // Verify episode belongs to project
    if (input.episodeId) {
      const [episode] = await db
        .select({ id: episodes.id, projectId: episodes.projectId })
        .from(episodes)
        .where(eq(episodes.id, input.episodeId));
      if (!episode || episode.projectId !== input.projectId) {
        return "Episode not found";
      }
    }

    // Verify scene belongs to project
    if (input.sceneId) {
      const [scene] = await db
        .select({ id: scenes.id, episodeId: scenes.episodeId, projectId: episodes.projectId })
        .from(scenes)
        .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
        .where(eq(scenes.id, input.sceneId));
      if (!scene || scene.projectId !== input.projectId) {
        return "Scene not found";
      }
    }

    // Verify shot belongs to project
    if (input.shotId) {
      const [shot] = await db
        .select({ id: shots.id, projectId: episodes.projectId })
        .from(shots)
        .innerJoin(scenes, eq(shots.sceneId, scenes.id))
        .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
        .where(eq(shots.id, input.shotId));
      if (!shot || shot.projectId !== input.projectId) {
        return "Shot not found";
      }
    }

    // Verify asset belongs to project
    if (input.assetId) {
      const [asset] = await db
        .select({ id: assets.id, projectId: assets.projectId })
        .from(assets)
        .where(eq(assets.id, input.assetId));
      if (!asset || asset.projectId !== input.projectId) {
        return "Referenced asset not found";
      }
    }

    // Verify provider & model if specified
    if (input.providerId) {
      const [provider] = await db
        .select({ id: aiProviders.id })
        .from(aiProviders)
        .where(eq(aiProviders.id, input.providerId));
      if (!provider) return "AI Provider not found";
    }

    if (input.modelId) {
      const [model] = await db
        .select({ id: aiModels.id, providerId: aiModels.providerId })
        .from(aiModels)
        .where(eq(aiModels.id, input.modelId));
      if (!model) return "AI Model not found";
      if (input.providerId && model.providerId !== input.providerId) {
        return "Model does not belong to the specified provider";
      }
    }

    return null;
  }

  async createJob(input: CreateGenerationJobInput) {
    const error = await this.validateOwnership(input);
    if (error) {
      throw new Error(error);
    }

    const db = getDb();
    const values = {
      projectId: input.projectId,
      jobType: input.jobType,
      status: "queued" as const,
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      episodeId: input.episodeId ?? null,
      sceneId: input.sceneId ?? null,
      shotId: input.shotId ?? null,
      shotVersionId: input.shotVersionId ?? null,
      assetId: input.assetId ?? null,
      prompt: input.prompt ?? null,
      negativePrompt: input.negativePrompt ?? null,
      targetMediaType: input.targetMediaType ?? null,
      requestedDuration: input.requestedDuration ?? null,
      requestedWidth: input.requestedWidth ?? null,
      requestedHeight: input.requestedHeight ?? null,
      progress: 0,
      metadata: input.metadata ?? null,
    };

    const [created] = await db.insert(aiJobs).values(values).$returningId();
    if (!created) throw new Error("Failed to insert AI job");

    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, created.id));
    return job;
  }

  async getJob(id: string) {
    const [job] = await getDb().select().from(aiJobs).where(eq(aiJobs.id, id));
    return job ?? null;
  }

  async listProjectJobs(projectId: string) {
    return await getDb()
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.projectId, projectId));
  }

  async updateJobStatus(
    id: string,
    targetStatus: GenerationJobStatus,
    details?: {
      progress?: number;
      error?: string | null;
      externalJobId?: string | null;
      assetVersionId?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const db = getDb();
    const [existing] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
    if (!existing) throw new Error("Job not found");

    const currentStatus = existing.status as GenerationJobStatus;
    if (!isValidJobStatusTransition(currentStatus, targetStatus)) {
      throw new Error(
        `Invalid job status transition from "${currentStatus}" to "${targetStatus}"`,
      );
    }

    const updateValues: Record<string, unknown> = {
      status: targetStatus,
    };

    if (details?.progress !== undefined) updateValues.progress = details.progress;
    if (details?.error !== undefined) updateValues.error = details.error;
    if (details?.externalJobId !== undefined) updateValues.externalJobId = details.externalJobId;
    if (details?.assetVersionId !== undefined) updateValues.assetVersionId = details.assetVersionId;
    if (details?.metadata !== undefined) updateValues.metadata = details.metadata;

    await db.update(aiJobs).set(updateValues).where(eq(aiJobs.id, id));
    const [updated] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
    return updated;
  }

  async cancelJob(id: string) {
    const db = getDb();
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
    if (!job) throw new Error("Job not found");

    const currentStatus = job.status as GenerationJobStatus;
    if (!isValidJobStatusTransition(currentStatus, "cancelled")) {
      throw new Error(`Cannot cancel job in "${currentStatus}" status`);
    }

    // Attempt provider-level cancellation if external job exists
    if (job.externalJobId && job.providerId) {
      const [provider] = await db
        .select()
        .from(aiProviders)
        .where(eq(aiProviders.id, job.providerId));
      if (provider) {
        const adapter = providerRegistry.get(provider.providerType);
        if (adapter && "cancelJob" in adapter) {
          try {
            await (adapter as any).cancelJob(job.externalJobId);
          } catch (e) {
            console.warn("Failed to cancel job with external provider adapter", e);
          }
        }
      }
    }

    return await this.updateJobStatus(id, "cancelled", {
      error: "Job cancelled by user",
    });
  }

  /**
   * Atomically creates an AssetVersion and links it to the given job.
   *
   * Concurrency guarantee (C5.3 hardening):
   *   The whole sequence runs inside a single MySQL transaction whose
   *   first DB action is a row-locking read of the target `ai_jobs`
   *   row (`SELECT ... FOR UPDATE`, gated on `asset_version_id IS
   *   NULL`). On MySQL/InnoDB, `FOR UPDATE` takes an exclusive row
   *   lock; the second concurrent caller for the same `jobId` blocks
   *   on that read until the first transaction commits, then resumes
   *   and observes `asset_version_id` is no longer NULL — so its
   *   locking SELECT returns zero rows and it throws
   *   `JobAlreadyLinkedError` BEFORE doing any `asset_versions`
   *   read or insert. Therefore two concurrent callers can never
   *   both compute the same `nextVersion` and both reach the
   *   `asset_versions` insert, which is what makes the
   *   `UNIQUE(asset_id, version)` index a pure safety net rather
   *   than a primary guard.
   *
   *   The conditional `WHERE asset_version_id IS NULL` on the final
   *   UPDATE remains as a defensive check; under normal operation
   *   it cannot fail because the row lock is already held, but it
   *   preserves the existing `affectedRows = 0` error path for any
   *   future caller that bypasses the locking read.
   *
   * NOT a guarantee of full storage+DB atomicity: the storage write
   * (see `generation_result.ts`) happens outside this transaction.
   * The caller is responsible for compensating storage cleanup if
   * this method throws.
   */
  async completeJobWithAssetVersion(
    jobId: string,
    assetId: string,
    versionData: {
      storageKey: string;
      mimeType?: string | null;
      fileExtension?: string | null;
      fileSize?: number | null;
      checksum?: string | null;
      width?: number | null;
      height?: number | null;
      duration?: number | null;
      prompt?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const db = getDb();
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    if (!job) throw new Error("Job not found");

    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
    if (!asset) throw new Error("Asset not found");

    return await db.transaction(async (tx) => {
      // 1. Lock the target ai_jobs row for the duration of this
      //    transaction. The `WHERE asset_version_id IS NULL` predicate
      //    is part of the locking SELECT, so a job that has already
      //    been linked by a concurrent (now-committed) transaction
      //    returns zero rows here — we reject with
      //    JobAlreadyLinkedError before touching asset_versions.
      //    On MySQL/InnoDB, `.for('update')` emits `FOR UPDATE` and
      //    takes an exclusive row lock, serializing concurrent
      //    callers for the same jobId.
      const lockRows = await tx
        .select({ id: aiJobs.id })
        .from(aiJobs)
        .where(and(eq(aiJobs.id, jobId), isNull(aiJobs.assetVersionId)))
        .for("update");
      if (lockRows.length === 0) {
        throw new JobAlreadyLinkedError(jobId);
      }

      // 2. Read existing AssetVersions and compute nextVersion. Safe to
      //    do now: we hold the ai_jobs row lock, so no concurrent
      //    caller for the same job can reach this point.
      const versions = await tx
        .select({ version: assetVersions.version })
        .from(assetVersions)
        .where(eq(assetVersions.assetId, assetId));
      const nextVersion =
        versions.length > 0
          ? Math.max(...versions.map((v) => v.version)) + 1
          : 1;

      // 3. INSERT the AssetVersion.
      const [createdVersion] = await tx
        .insert(assetVersions)
        .values({
          assetId,
          version: nextVersion,
          status: "ready",
          sourceKind: "generated",
          storageKey: versionData.storageKey,
          mimeType: versionData.mimeType ?? null,
          fileExtension: versionData.fileExtension ?? null,
          fileSize: versionData.fileSize ?? null,
          checksum: versionData.checksum ?? null,
          width: versionData.width ?? null,
          height: versionData.height ?? null,
          duration: versionData.duration ?? null,
          prompt: versionData.prompt ?? job.prompt ?? null,
          jobId: job.id,
          metadata: versionData.metadata ?? null,
        })
        .$returningId();

      if (!createdVersion) {
        throw new Error("Failed to insert asset version for completed job");
      }

      // 4. Link the AssetVersion to the job. The `assetVersionId IS
      //    NULL` predicate is defensive: under the row lock it cannot
      //    fail, but if a future refactor removes the locking read
      //    this still drives the existing `affectedRows = 0` error
      //    path.
      const updateResult = await tx
        .update(aiJobs)
        .set({
          status: "completed",
          progress: 100,
          assetVersionId: createdVersion.id,
        })
        .where(and(eq(aiJobs.id, jobId), isNull(aiJobs.assetVersionId)));

      const affected = (updateResult as unknown as { affectedRows?: number })
        .affectedRows;
      if (affected === 0) {
        throw new JobAlreadyLinkedError(jobId);
      }

      return createdVersion;
    });
  }
}

export const generationJobService = new GenerationJobService();
