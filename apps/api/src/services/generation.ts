import { eq } from "drizzle-orm";
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

    // Deterministic version numbering: max(version) + 1
    const versions = await db
      .select({ version: assetVersions.version })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, assetId));
    const nextVersion =
      versions.length > 0
        ? Math.max(...versions.map((v) => v.version)) + 1
        : 1;

    const [createdVersion] = await db
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

    // Update job to completed referencing the new version
    return await this.updateJobStatus(jobId, "completed", {
      progress: 100,
      assetVersionId: createdVersion.id,
    });
  }
}

export const generationJobService = new GenerationJobService();
