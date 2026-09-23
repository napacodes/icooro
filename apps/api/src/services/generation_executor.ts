import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { aiProviders } from "../db/schema/ai_providers.js";
import { aiModels } from "../db/schema/ai_models.js";
import { generationJobService, isValidJobStatusTransition } from "./generation.js";
import { resolveVideoProvider } from "../providers/factory.js";
import type { GenerationJobStatus, VideoGenerationParams } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ExecutorError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
  }
}

/** Job was not found in the database. */
export class ExecutorJobNotFoundError extends ExecutorError {
  constructor(jobId: string) {
    super(`Job "${jobId}" not found`, "JOB_NOT_FOUND");
    this.name = "ExecutorJobNotFoundError";
  }
}

/** The job is not in the required state for the requested operation. */
export class ExecutorInvalidStateError extends ExecutorError {
  constructor(message: string) {
    super(message, "INVALID_STATE");
    this.name = "ExecutorInvalidStateError";
  }
}

/** Required execution configuration is missing (provider / model / prompt). */
export class ExecutorConfigError extends ExecutorError {
  constructor(message: string) {
    super(message, "MISSING_CONFIG");
    this.name = "ExecutorConfigError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a safe, short error message for storage.
 *
 * Redacts:
 *   - HTTP/HTTPS URLs (may carry signed paths or query credentials)
 *   - Common credential-bearing header/field patterns:
 *       Authorization: Bearer ..., apiKey=..., api_key=...,
 *       token=..., secretKey=..., password=...
 *
 * Truncates to 500 characters so the database text column is not abused.
 */
function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    // Strip http(s) URLs (signed media URLs, provider endpoints)
    .replace(/https?:\/\/[^\s"')]+/g, "[url]")
    // Strip Authorization: Bearer <token>
    .replace(/authorization:\s*bearer\s+\S+/gi, "authorization: bearer [redacted]")
    // Strip apiKey=, api_key=, token=, secretKey=, password= (value up to next & or end)
    .replace(/\b(apiKey|api_key|token|secretKey|secret_key|password)\s*=\s*[^\s&"',;)]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

/**
 * Merges provider-returned metadata into existing job metadata.
 * Both arguments may be null / undefined. The result is always a plain
 * JSON-safe Record so it can be persisted in the metadata JSON column.
 */
function mergeMetadata(
  existing: unknown,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!incoming || Object.keys(incoming).length === 0) {
    // Nothing new — keep existing as-is (or null if not yet set)
    return existing != null && typeof existing === "object"
      ? (existing as Record<string, unknown>)
      : null;
  }
  const base =
    existing != null && typeof existing === "object"
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...incoming };
}

// ---------------------------------------------------------------------------
// Bounded-poll options
// ---------------------------------------------------------------------------

export interface BoundedPollOptions {
  /** Maximum number of poll calls before giving up. Default: 60. */
  maxPolls?: number;
  /** Milliseconds to wait between polls. Default: 5000. */
  pollIntervalMs?: number;
  /**
   * Injectable sleep function. Defaults to a real timer-based delay.
   * Tests inject a no-op to avoid real waiting.
   */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLLS = 60;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// In-process duplicate-submission guard (Fix 3)
// ---------------------------------------------------------------------------

/**
 * Tracks job IDs currently in the middle of submitJob().
 *
 * Purpose: prevent a second concurrent HTTP request from calling
 * provider.createJob() for the same Icooro job while the first request
 * is still awaiting the provider response.
 *
 * This is an in-process guard only — it does not provide distributed locking.
 * After the first submission completes (job is no longer "queued"), any
 * subsequent submitJob() call will be rejected by the queued-status check.
 */
const submissionsInFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Terminal statuses — polling is not meaningful for these
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GenerationExecutorService {
  /**
   * Submits a queued Icooro generation job to its configured VideoProvider.
   *
   * Lifecycle: queued → submitted  (or queued → failed on provider error)
   *
   * Throws:
   *   ExecutorJobNotFoundError  – job does not exist
   *   ExecutorInvalidStateError – job is not in "queued" status, or a concurrent
   *                               submission is already in progress for this job
   *   ExecutorConfigError       – provider / model / prompt missing or invalid
   *
   * Provider errors are caught and converted to a failed job (not re-thrown).
   *
   * Fix 3 — concurrent-submission guard:
   *   If submitJob() is called concurrently for the same jobId, the second
   *   caller receives ExecutorInvalidStateError immediately without reaching
   *   the provider. After the first call completes, subsequent callers see
   *   the job as "submitted" and are rejected by the status check.
   */
  async submitJob(jobId: string) {
    // --- In-process duplicate-submission guard ---
    if (submissionsInFlight.has(jobId)) {
      throw new ExecutorInvalidStateError(
        `Job "${jobId}" is already being submitted — concurrent submission rejected`,
      );
    }
    submissionsInFlight.add(jobId);

    try {
      return await this._doSubmitJob(jobId);
    } finally {
      submissionsInFlight.delete(jobId);
    }
  }

  /** Internal submit implementation, called only when the lock is held. */
  private async _doSubmitJob(jobId: string) {
    // 1. Load job
    const job = await generationJobService.getJob(jobId);
    if (!job) throw new ExecutorJobNotFoundError(jobId);

    // 2. Require queued status
    if (job.status !== "queued") {
      throw new ExecutorInvalidStateError(
        `Job "${jobId}" cannot be submitted: status is "${job.status}", expected "queued"`,
      );
    }

    // 3. Require providerId
    if (!job.providerId) {
      throw new ExecutorConfigError(
        `Job "${jobId}" has no provider configured`,
      );
    }

    // 4. Load provider DB record
    const db = getDb();
    const [providerRecord] = await db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, job.providerId));
    if (!providerRecord) {
      throw new ExecutorConfigError(
        `Provider "${job.providerId}" not found in database`,
      );
    }

    // 5. Resolve adapter (record-configured when the type has a factory,
    //    otherwise the registry singleton) and require video capability.
    const adapter = resolveVideoProvider(providerRecord);
    if (!adapter) {
      throw new ExecutorConfigError(
        `No registered VideoProvider for type "${providerRecord.providerType}"`,
      );
    }

    // 6. Require modelId
    if (!job.modelId) {
      throw new ExecutorConfigError(
        `Job "${jobId}" has no model configured`,
      );
    }

    // 7. Load model DB record
    const [modelRecord] = await db
      .select()
      .from(aiModels)
      .where(eq(aiModels.id, job.modelId));
    if (!modelRecord) {
      throw new ExecutorConfigError(
        `Model "${job.modelId}" not found in database`,
      );
    }

    // 8. Require prompt
    if (!job.prompt) {
      throw new ExecutorConfigError(
        `Job "${jobId}" has no prompt configured`,
      );
    }

    // 9. Build VideoGenerationParams
    const params: VideoGenerationParams = {
      prompt: job.prompt,
      modelId: modelRecord.modelId,
      ...(job.negativePrompt != null ? { negativePrompt: job.negativePrompt } : {}),
      ...(job.requestedDuration != null ? { duration: job.requestedDuration } : {}),
      ...(job.requestedWidth != null ? { width: job.requestedWidth } : {}),
      ...(job.requestedHeight != null ? { height: job.requestedHeight } : {}),
      ...(job.metadata != null && typeof job.metadata === "object"
        ? { metadata: job.metadata as Record<string, unknown> }
        : {}),
    };

    // 10. Call adapter.createJob() — wrap in try/catch; provider errors → failed
    let externalJobId: string;
    let providerMeta: Record<string, unknown> | undefined;

    try {
      const result = await adapter.createJob(params);
      externalJobId = result.externalJobId;
      providerMeta = result.metadata;
    } catch (err: unknown) {
      // Provider failure: transition queued → failed, persist safe error
      await generationJobService.updateJobStatus(jobId, "failed", {
        error: safeErrorMessage(err),
      });
      // Return the failed job to the caller (no re-throw)
      return await generationJobService.getJob(jobId);
    }

    // 11. Transition queued → submitted, persist externalJobId + metadata
    const merged = mergeMetadata(job.metadata, providerMeta ?? null);
    return await generationJobService.updateJobStatus(jobId, "submitted", {
      externalJobId,
      metadata: merged,
    });
  }

  /**
   * Polls the provider for the current status of a submitted/processing job
   * and mirrors the result into the Icooro job record.
   *
   * Lifecycle mirrors: submitted/processing/completed/failed/cancelled
   * Does NOT download media. Does NOT create AssetVersions.
   * Stores resultUrl in job metadata if the provider returns one.
   *
   * Fix 1 — provider returns completed while Icooro is still submitted:
   *   The Icooro lifecycle only allows processing → completed.
   *   If the provider skips directly to completed (fast generation), this
   *   method steps the job through processing first (persisting all data),
   *   then to completed — in a single pollJob() call, without a second
   *   provider request.
   *
   * Fix 2 — terminal job guard:
   *   Polling a job already in completed/failed/cancelled is rejected before
   *   the provider is contacted (ExecutorInvalidStateError).
   *
   * Throws:
   *   ExecutorJobNotFoundError   – job does not exist
   *   ExecutorInvalidStateError  – job is already terminal
   *   ExecutorConfigError        – job has no externalJobId or no provider
   */
  async pollJob(jobId: string) {
    // 1. Load job
    const job = await generationJobService.getJob(jobId);
    if (!job) throw new ExecutorJobNotFoundError(jobId);

    // 2. Fix 2 — reject polling of already-terminal jobs
    if (TERMINAL_STATUSES.has(job.status as string)) {
      throw new ExecutorInvalidStateError(
        `Job "${jobId}" is already in terminal status "${job.status}" and cannot be polled`,
      );
    }

    // 3. Require externalJobId
    if (!job.externalJobId) {
      throw new ExecutorConfigError(
        `Job "${jobId}" has no externalJobId — it must be submitted before polling`,
      );
    }

    // 4. Require providerId
    if (!job.providerId) {
      throw new ExecutorConfigError(
        `Job "${jobId}" has no provider configured`,
      );
    }

    // 5. Load provider DB record + resolve adapter
    const db = getDb();
    const [providerRecord] = await db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, job.providerId));
    if (!providerRecord) {
      throw new ExecutorConfigError(
        `Provider "${job.providerId}" not found in database`,
      );
    }

    const adapter = resolveVideoProvider(providerRecord);
    if (!adapter) {
      throw new ExecutorConfigError(
        `No registered VideoProvider for type "${providerRecord.providerType}"`,
      );
    }

    // 6. Call adapter.getJobStatus()
    let statusResult;
    try {
      statusResult = await adapter.getJobStatus(job.externalJobId);
    } catch (err: unknown) {
      // Provider polling error — transition current status → failed
      await generationJobService.updateJobStatus(jobId, "failed", {
        error: safeErrorMessage(err),
      });
      return await generationJobService.getJob(jobId);
    }

    // 7. Map provider status to Icooro target status
    const providerStatus = statusResult.status;
    const currentStatus = job.status as GenerationJobStatus;

    // Build metadata/progress details to persist regardless of which transition fires
    let mergedMeta = mergeMetadata(job.metadata, statusResult.metadata ?? null);
    if (typeof statusResult.resultUrl === "string") {
      mergedMeta = {
        ...(mergedMeta ?? {}),
        resultUrl: statusResult.resultUrl,
      };
    }

    const details: Parameters<typeof generationJobService.updateJobStatus>[2] = {
      ...(statusResult.progress !== undefined ? { progress: statusResult.progress } : {}),
      ...(statusResult.error !== undefined
        ? { error: safeErrorMessage(statusResult.error) }
        : {}),
      ...(mergedMeta !== null ? { metadata: mergedMeta } : {}),
    };

    // "cancelled" from provider is only honoured if it's a valid transition
    if (providerStatus === "cancelled") {
      if (!isValidJobStatusTransition(currentStatus, "cancelled")) {
        // Job is already terminal — return as-is (guard above already handles
        // terminal jobs; this path is reached only for non-terminal statuses
        // where cancelled is still somehow invalid)
        return await generationJobService.getJob(jobId);
      }
    }

    // Fix 1 — handle provider returning completed while Icooro is still submitted.
    //
    // VALID_TRANSITIONS: submitted → processing → completed
    // If provider skips directly to completed, the direct transition
    // submitted → completed is invalid. Step through processing first,
    // then apply completed. No second provider call is made.
    if (
      providerStatus === "completed" &&
      !isValidJobStatusTransition(currentStatus, "completed")
    ) {
      // Step through intermediate status(es) until completed is reachable.
      // For the current lifecycle the only gap is submitted → (processing) → completed.
      if (isValidJobStatusTransition(currentStatus, "processing")) {
        await generationJobService.updateJobStatus(jobId, "processing", details);
      }
      // Now completed should be reachable from processing
      return await generationJobService.updateJobStatus(jobId, "completed", details);
    }

    // Standard path: apply provider status directly
    return await generationJobService.updateJobStatus(jobId, providerStatus, details);
  }

  /**
   * Deterministic bounded poll helper.
   *
   * 1. Calls submitJob() once.
   * 2. Polls up to `maxPolls` times with `pollIntervalMs` delay between calls.
   * 3. Stops immediately when status is completed / failed / cancelled.
   * 4. If maxPolls is exhausted the job is returned as-is — no new status is
   *    invented and no error is thrown.
   *
   * The `sleep` option is injectable for tests (pass a no-op to avoid delays).
   */
  async runBoundedPoll(jobId: string, opts?: BoundedPollOptions) {
    const maxPolls = opts?.maxPolls ?? DEFAULT_MAX_POLLS;
    const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = opts?.sleep ?? defaultSleep;

    // Submit once
    const submitted = await this.submitJob(jobId);

    // If submit itself resulted in a terminal state (e.g. failed), stop early
    if (submitted && TERMINAL_STATUSES.has(submitted.status as string)) {
      return submitted;
    }

    // Poll loop
    let current = submitted;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollIntervalMs);

      current = await this.pollJob(jobId);

      if (current && TERMINAL_STATUSES.has(current.status as string)) {
        return current;
      }
    }

    // Reached maxPolls — return job in its current state
    return current;
  }
}

export const generationExecutorService = new GenerationExecutorService();
