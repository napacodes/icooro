import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { aiProviders } from "../db/schema/ai_providers.js";
import { assetVersions } from "../db/schema/asset_versions.js";
import { assets } from "../db/schema/assets.js";
import { providerRegistry } from "../providers/registry.js";
import { generationJobService, JobAlreadyLinkedError } from "./generation.js";
import { getStorageProvider } from "../storage/index.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ResultError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ResultError";
    this.code = code;
  }
}

export class ResultJobNotFoundError extends ResultError {
  constructor(jobId: string) {
    super(`Job "${jobId}" not found`, "JOB_NOT_FOUND");
    this.name = "ResultJobNotFoundError";
  }
}

export class ResultOwnershipError extends ResultError {
  constructor(jobId: string, projectId: string) {
    super(`Job "${jobId}" does not belong to project "${projectId}"`, "FORBIDDEN");
    this.name = "ResultOwnershipError";
  }
}

export class ResultInvalidStateError extends ResultError {
  constructor(message: string) {
    super(message, "INVALID_STATE");
    this.name = "ResultInvalidStateError";
  }
}

export class ResultConfigError extends ResultError {
  constructor(message: string) {
    super(message, "MISSING_CONFIG");
    this.name = "ResultConfigError";
  }
}

export class ResultDownloadError extends ResultError {
  constructor(message: string) {
    super(message, "DOWNLOAD_FAILED");
    this.name = "ResultDownloadError";
  }
}

export class ResultStorageError extends ResultError {
  constructor(message: string) {
    super(message, "STORAGE_FAILED");
    this.name = "ResultStorageError";
  }
}

export class ResultAlreadyPersistedError extends ResultError {
  constructor(jobId: string, assetVersionId: string) {
    super(
      `Job "${jobId}" result already persisted as AssetVersion "${assetVersionId}"`,
      "ALREADY_PERSISTED",
    );
    this.name = "ResultAlreadyPersistedError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitizes error messages before storing or returning them.
 * Removes HTTP(S) URLs and common credential-bearing patterns.
 */
function safeResultError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/[^\s"')]+/g, "[url]")
    .replace(/authorization:\s*bearer\s+\S+/gi, "authorization: bearer [redacted]")
    .replace(/\b(apiKey|api_key|token|secretKey|secret_key|password)\s*=\s*[^\s&"',;)]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

/**
 * Derives a MIME type from a file extension. Falls back to the provider-supplied
 * mimeType, then to a generic octet-stream default.
 */
function inferMimeType(fileExtension: string | undefined, providerMime: string): string {
  if (fileExtension) {
    const ext = fileExtension.toLowerCase().replace(/^\./, "");
    const map: Record<string, string> = {
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      mp3: "audio/mpeg",
      wav: "audio/wav",
    };
    if (map[ext]) return map[ext];
  }
  return providerMime || "application/octet-stream";
}

/**
 * Derives a safe file extension from a MIME type or provider-supplied extension.
 */
function inferExtension(fileExtension: string | undefined, mimeType: string): string {
  if (fileExtension) return fileExtension.replace(/^\./, "");
  const map: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  return map[mimeType] ?? "bin";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GenerationResultService {
  /**
   * Downloads the provider result for a completed generation job and persists
   * it as an AssetVersion in Icooro's own storage.
   *
   * Flow:
   *   1. Load job → verify project ownership → require completed status
   *   2. Idempotency check: if job.assetVersionId already set, throw
   *      ResultAlreadyPersistedError (this is the cheap pre-check; the
   *      authoritative guarantee lives in `completeJobWithAssetVersion`,
   *      which uses a conditional UPDATE inside a DB transaction to
   *      serialize concurrent callers on the ai_jobs row)
   *   3. Require assetId on the job
   *   4. Require resultUrl in job metadata (set by pollJob)
   *   5. Resolve provider via providerRegistry
   *   6. downloadResult() from provider
   *   7. Build deterministic storage key: generated/{projectId}/{jobId}/{jobId}.{ext}
   *   8. Persist bytes via StorageProvider
   *  9. Call generationJobService.completeJobWithAssetVersion() — runs
   *      inside a single MySQL transaction whose first DB action is a
   *      `SELECT ... FOR UPDATE` on the target ai_jobs row gated on
   *      `asset_version_id IS NULL`. The first concurrent caller takes
   *      the row lock and proceeds; any later concurrent caller for
   *      the same job blocks on that lock, then sees
   *      `asset_version_id` non-null and is rejected with
   *      `JobAlreadyLinkedError` BEFORE any AssetVersion insert. We
   *      translate that to `ResultAlreadyPersistedError` below.
   *  10. On any failure between step 8 and the successful return, delete
   *      the stored object so we do not leak orphan bytes on disk.
   *
   * Storage cleanup contract:
   *   Once `storage.put()` has succeeded, ANY subsequent throw from
   *   this method (DB error, concurrent-link rejection, post-write
   *   read failure) triggers a best-effort `storage.delete(storageKey)`
   *   before the error is rethrown. A failure of the cleanup itself
   *   is logged but never replaces the original error.
   *
   * NOT atomic across storage and DB: the storage write happens before
   * the DB transaction. The compensating delete above keeps the two
   * consistent in the common failure cases. The only remaining
   * inconsistency window is a process crash between `put` and the
   * transaction commit, which would leave an orphan file with no DB
   * row — that is acceptable for this phase and is the same window
   * any S3-style workflow would have without an outbox.
   *
   * Throws:
   *   ResultJobNotFoundError       – job does not exist
   *   ResultOwnershipError         – job belongs to a different project
   *   ResultInvalidStateError      – job is not completed
   *   ResultConfigError            – assetId / provider / resultUrl missing
   *   ResultAlreadyPersistedError  – result already persisted (idempotency)
   *   ResultDownloadError          – provider download failed
   *   ResultStorageError           – storage write failed
   */
  async persistResult(jobId: string, projectId: string) {
    const db = getDb();

    // 1. Load job
    const job = await generationJobService.getJob(jobId);
    if (!job) throw new ResultJobNotFoundError(jobId);

    // 2. Verify project ownership
    if (job.projectId !== projectId) {
      throw new ResultOwnershipError(jobId, projectId);
    }

    // 3. Require completed status
    if (job.status !== "completed") {
      throw new ResultInvalidStateError(
        `Job "${jobId}" must be in "completed" status to persist result; current status is "${job.status}"`,
      );
    }

    // 4. Idempotency pre-check: if this job already has an assetVersionId,
    //    it was already persisted. The authoritative guard is the
    //    `SELECT ... FOR UPDATE` on ai_jobs inside
    //    `completeJobWithAssetVersion` (gated on `assetVersionId IS
    //    NULL`), but failing fast here avoids a wasted download +
    //    storage write for the common sequential-retry case.
    if (job.assetVersionId) {
      throw new ResultAlreadyPersistedError(jobId, job.assetVersionId);
    }

    // 5. Require assetId — the caller (or upstream job creation) must have linked an asset
    if (!job.assetId) {
      throw new ResultConfigError(
        `Job "${jobId}" has no assetId — cannot create an AssetVersion without a target Asset`,
      );
    }

    // 6. Verify the asset exists and belongs to this project
    const [asset] = await db
      .select({ id: assets.id, projectId: assets.projectId })
      .from(assets)
      .where(eq(assets.id, job.assetId));
    if (!asset || asset.projectId !== projectId) {
      throw new ResultConfigError(
        `Asset "${job.assetId}" not found in project "${projectId}"`,
      );
    }

    // 7. Require resultUrl in job metadata (persisted during pollJob)
    const jobMeta = job.metadata as Record<string, unknown> | null;
    const resultUrl =
      jobMeta && typeof jobMeta["resultUrl"] === "string" ? jobMeta["resultUrl"] : null;
    if (!resultUrl) {
      throw new ResultConfigError(
        `Job "${jobId}" has no resultUrl in metadata — poll the job first to obtain the provider result URL`,
      );
    }

    // 8. Require providerId and resolve the VideoProvider adapter
    if (!job.providerId) {
      throw new ResultConfigError(`Job "${jobId}" has no provider configured`);
    }

    const [providerRecord] = await db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, job.providerId));
    if (!providerRecord) {
      throw new ResultConfigError(`Provider "${job.providerId}" not found in database`);
    }

    const adapter = providerRegistry.getVideoProvider(providerRecord.providerType);
    if (!adapter) {
      throw new ResultConfigError(
        `No registered VideoProvider for type "${providerRecord.providerType}"`,
      );
    }

    // 9. Require externalJobId for the download call
    if (!job.externalJobId) {
      throw new ResultConfigError(
        `Job "${jobId}" has no externalJobId — cannot download result`,
      );
    }

    // 10. Download result from provider
    let downloadResult;
    try {
      downloadResult = await adapter.downloadResult(job.externalJobId);
    } catch (err: unknown) {
      throw new ResultDownloadError(
        `Failed to download result for job "${jobId}": ${safeResultError(err)}`,
      );
    }

    // 11. Build deterministic, project-scoped storage key
    //     Format: generated/{projectId}/{jobId}/{jobId}.{ext}
    //     - No raw provider URLs
    //     - No path traversal possible (all segments are UUIDs or safe strings)
    const ext = inferExtension(downloadResult.fileExtension, downloadResult.mimeType);
    const storageKey = `generated/${projectId}/${jobId}/${jobId}.${ext}`;
    const mimeType = inferMimeType(downloadResult.fileExtension, downloadResult.mimeType);

    // 12. Persist bytes via StorageProvider
    const storage = getStorageProvider();
    let putResult;
    try {
      putResult = await storage.put(storageKey, downloadResult.data, { mimeType });
    } catch (err: unknown) {
      throw new ResultStorageError(
        `Failed to store result for job "${jobId}": ${safeResultError(err)}`,
      );
    }

    // From this point on, any thrown error must clean up the bytes we just wrote.
    // We use a small wrapper instead of a broad try/catch so the success path
    // stays linear and the cleanup logic is in one place.
    try {
      // 13. Build AssetVersion metadata — generation provenance
      const versionMetadata: Record<string, unknown> = {
        generationJobId: job.id,
        externalJobId: job.externalJobId,
        providerType: providerRecord.providerType,
        modelId: job.modelId,
        targetMediaType: job.targetMediaType,
      };
      if (job.requestedDuration != null) versionMetadata.requestedDuration = job.requestedDuration;
      if (job.requestedWidth != null) versionMetadata.requestedWidth = job.requestedWidth;
      if (job.requestedHeight != null) versionMetadata.requestedHeight = job.requestedHeight;
      // Preserve provider-specific metadata from the job (minus the transient resultUrl)
      if (jobMeta) {
        const { resultUrl: _dropped, ...rest } = jobMeta;
        if (Object.keys(rest).length > 0) versionMetadata.providerMetadata = rest;
      }

      // 14. Create AssetVersion and link to job. The DB transaction in
      //     `completeJobWithAssetVersion` starts with a
      //     `SELECT ... FOR UPDATE` on ai_jobs gated on
      //     `assetVersionId IS NULL`; that row lock serializes
      //     concurrent callers, and the second one observes a non-null
      //     `assetVersionId` and is rejected with
      //     `JobAlreadyLinkedError` before any AssetVersion insert.
      try {
        await generationJobService.completeJobWithAssetVersion(jobId, job.assetId, {
          storageKey: putResult.key,
          mimeType,
          fileExtension: ext,
          fileSize: putResult.size,
          width: job.requestedWidth ?? null,
          height: job.requestedHeight ?? null,
          duration: job.requestedDuration ?? null,
          prompt: job.prompt ?? null,
          metadata: versionMetadata,
        });
      } catch (err: unknown) {
        if (err instanceof JobAlreadyLinkedError) {
          // We lost the race against a concurrent persistResult for the
          // same job. The storage key is deterministic from jobId, so
          // our `put` wrote the same key the winner is now using for
          // the linked AssetVersion. Deleting it would destroy the
          // winner's bytes — do NOT delete. Surface the existing
          // `ResultAlreadyPersistedError` semantics so the caller
          // behaves identically to a sequential already-persisted call.
          const winner = await generationJobService.getJob(jobId);
          throw new ResultAlreadyPersistedError(
            jobId,
            winner?.assetVersionId ?? "unknown",
          );
        }
        throw err;
      }

      // 15. Return the freshly created AssetVersion row
      const updatedJob = await generationJobService.getJob(jobId);
      if (!updatedJob?.assetVersionId) {
        throw new ResultStorageError(
          `AssetVersion was not linked to job "${jobId}" after persistence`,
        );
      }

      const [version] = await db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, updatedJob.assetVersionId));

      return version ?? null;
    } catch (err: unknown) {
      // Compensating storage cleanup. The original error is always
      // rethrown; a cleanup failure is logged but never replaces it.
      //
      // Skip cleanup for `ResultAlreadyPersistedError`: this is the
      // benign "we lost the race" path, and the storage key is shared
      // with the winning concurrent caller (it is deterministic from
      // jobId), so deleting it would destroy the winner's bytes.
      if (!(err instanceof ResultAlreadyPersistedError)) {
        await this.safeDeleteStorage(storage, putResult.key, jobId);
      }
      throw err;
    }
  }

  /**
   * Best-effort storage delete that never throws. Used for orphan cleanup
   * after a partial persistence failure. Failures are logged to stderr so
   * operators can detect accumulated orphan files, but the original error
   * is never masked.
   */
  private async safeDeleteStorage(
    storage: ReturnType<typeof getStorageProvider>,
    key: string,
    jobId: string,
  ): Promise<void> {
    try {
      await storage.delete(key);
    } catch (cleanupErr: unknown) {
      console.warn(
        `[generation_result] orphan cleanup failed for job "${jobId}" key "${key}":`,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      );
    }
  }

  /**
   * Returns the existing AssetVersion for a job that has already been persisted,
   * or null if no version has been created yet.
   */
  async getPersistedVersion(jobId: string, projectId: string) {
    const job = await generationJobService.getJob(jobId);
    if (!job) throw new ResultJobNotFoundError(jobId);
    if (job.projectId !== projectId) throw new ResultOwnershipError(jobId, projectId);
    if (!job.assetVersionId) return null;

    const db = getDb();
    const [version] = await db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.id, job.assetVersionId));
    return version ?? null;
  }
}

export const generationResultService = new GenerationResultService();
