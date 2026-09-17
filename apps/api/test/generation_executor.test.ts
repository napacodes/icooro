/**
 * C5.2 – Generation Executor Tests
 *
 * All tests use:
 *   - A deterministic in-memory fake DB (setDb) — no real MySQL connection
 *   - A local inline VideoProvider mock per scenario — no real ChatFire calls
 *   - An injectable no-op sleep function — no real waiting in bounded-poll tests
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { setDb } from "../src/db/index.js";
import { providerRegistry } from "../src/providers/registry.js";
import {
  GenerationExecutorService,
  ExecutorJobNotFoundError,
  ExecutorInvalidStateError,
  ExecutorConfigError,
} from "../src/services/generation_executor.js";
import type {
  VideoProvider,
  VideoGenerationParams,
  JobStatusResult,
} from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Drizzle internals helpers
// ---------------------------------------------------------------------------

const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name");

/**
 * Extracts the right-hand value from a drizzle eq() SQL condition.
 * eq(table.col, value) produces an SQL object whose queryChunks[3] is a
 * Param with .value holding the literal comparison value.
 */
function extractEqValue(cond: unknown): string | null {
  const chunks = (cond as any)?.queryChunks;
  if (!Array.isArray(chunks) || chunks.length < 4) return null;
  const param = chunks[3];
  return param?.value ?? null;
}

/**
 * Extracts the drizzle table name from a table object passed to .from().
 */
function tableNameOf(table: unknown): string {
  return (table as any)?.[DRIZZLE_TABLE_NAME] ?? "";
}

// ---------------------------------------------------------------------------
// Fake DB infrastructure
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Drizzle-compatible fake database that covers the exact
 * query patterns used by GenerationJobService and GenerationExecutorService.
 *
 * Patterns covered:
 *   db.select().from(table).where(eq(table.id, id))  → returns row array
 *   db.update(table).set(values).where(eq(table.id, id))  → updates in-place
 *   db.insert(table).values(vals).$returningId()  → not needed (jobs pre-seeded)
 */
function makeFakeDb(
  jobs: Map<string, Record<string, unknown>>,
  providers: Map<string, Record<string, unknown>>,
  models: Map<string, Record<string, unknown>>,
) {
  function resolveStore(tableName: string): Map<string, Record<string, unknown>> {
    if (tableName === "ai_providers") return providers;
    if (tableName === "ai_models") return models;
    return jobs; // ai_jobs and anything else defaults to jobs
  }

  const fakeDb: any = {
    select() {
      return {
        from(table: unknown) {
          const storeName = tableNameOf(table);
          return {
            where(cond: unknown) {
              const id = extractEqValue(cond);
              const store = resolveStore(storeName);
              const row = id ? store.get(id) : undefined;
              return Promise.resolve(row ? [{ ...row }] : []);
            },
            // Support calls without .where() (e.g. listProjectJobs — not needed
            // in executor tests, but guard just in case)
            then(resolve: any) {
              return resolve([]);
            },
          };
        },
      };
    },

    update(table: unknown) {
      const storeName = tableNameOf(table);
      return {
        set(values: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              const id = extractEqValue(cond);
              if (id) {
                const store = resolveStore(storeName);
                const existing = store.get(id);
                if (existing) {
                  Object.assign(existing, values);
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },

    insert(_table: unknown) {
      return {
        values(_vals: unknown) {
          return {
            $returningId() {
              // Pre-seeded tests don't call insert
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };

  return fakeDb;
}

// ---------------------------------------------------------------------------
// Fake row factories
// ---------------------------------------------------------------------------

const PROVIDER_TYPE = "test-mock";

function makeProvider(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: randomUUID(),
    name: "Test Provider",
    providerType: PROVIDER_TYPE,
    enabled: true,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeModel(providerId: string, overrides?: Partial<Record<string, unknown>>) {
  return {
    id: randomUUID(),
    providerId,
    name: "Test Model",
    modelId: "test-model-v1",
    capability: "video",
    enabled: true,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeJob(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: randomUUID(),
    jobType: "video",
    status: "queued",
    providerId: null as string | null,
    modelId: null as string | null,
    externalJobId: null as string | null,
    projectId: randomUUID(),
    episodeId: null,
    sceneId: null,
    shotId: null,
    shotVersionId: null,
    assetId: null,
    assetVersionId: null,
    prompt: "a cinematic test scene",
    negativePrompt: null,
    targetMediaType: "video",
    requestedDuration: null,
    requestedWidth: null,
    requestedHeight: null,
    progress: 0,
    error: null as string | null,
    metadata: null as Record<string, unknown> | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-process VideoProvider mock builder
// ---------------------------------------------------------------------------

function makeMockVideoProvider(opts: {
  createJobResult?: () => Promise<{ externalJobId: string; metadata?: Record<string, unknown> }>;
  getJobStatusSequence?: JobStatusResult[];
}): VideoProvider {
  let statusCallCount = 0;
  const sequence = opts.getJobStatusSequence ?? [];

  return {
    providerType: PROVIDER_TYPE,
    name: "Test Mock Provider",
    capabilities: ["video"] as const,

    async testConnection() {
      return { ok: true };
    },

    async createJob(_params: VideoGenerationParams) {
      if (opts.createJobResult) return opts.createJobResult();
      return { externalJobId: `ext-${randomUUID()}`, metadata: { engine: "test" } };
    },

    async getJobStatus(_externalJobId: string) {
      const result = sequence[statusCallCount] ?? sequence[sequence.length - 1];
      statusCallCount++;
      if (!result) throw new Error("getJobStatus called but no sequence entry defined");
      return { ...result };
    },

    async cancelJob(_externalJobId: string) {
      return { cancelled: true };
    },

    async downloadResult(_externalJobId: string) {
      throw new Error("downloadResult must not be called in C5.2 tests");
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

/**
 * Prepares an isolated test environment:
 *  - Fresh in-memory stores for jobs / providers / models
 *  - Fake DB injected via setDb()
 *  - Mock provider registered in the real global providerRegistry
 *  - Returns a fresh GenerationExecutorService and a teardown function
 */
function setupTest(mockProvider: VideoProvider) {
  const jobs = new Map<string, Record<string, unknown>>();
  const providers = new Map<string, Record<string, unknown>>();
  const models = new Map<string, Record<string, unknown>>();

  const fakeDb = makeFakeDb(jobs, providers, models);
  setDb(fakeDb);

  providerRegistry.register(mockProvider);

  const executor = new GenerationExecutorService();

  function teardown() {
    providerRegistry.unregister(mockProvider.providerType);
  }

  return { jobs, providers, models, executor, teardown };
}

// ---------------------------------------------------------------------------
// Scenario 1: queued job submits successfully
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 1: queued job submits successfully", async () => {
  let createJobCalledWith: VideoGenerationParams | null = null;
  let createJobCallCount = 0;

  const baseMock = makeMockVideoProvider({
    createJobResult: async () => ({
      externalJobId: "ext-scenario-1",
      metadata: { engine: "test", model: "test-model-v1" },
    }),
  });

  // Wrap createJob to capture call
  const origCreate = baseMock.createJob.bind(baseMock);
  baseMock.createJob = async (params: VideoGenerationParams) => {
    createJobCalledWith = params;
    createJobCallCount++;
    return origCreate(params);
  };

  const { jobs, providers, models, executor, teardown } = setupTest(baseMock);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({ status: "queued", providerId: provider.id, modelId: model.id });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const result = await executor.submitJob(job.id as string);

  // provider.createJob called exactly once
  assert.equal(createJobCallCount, 1, "createJob must be called exactly once");

  // Params forwarded correctly
  assert.ok(createJobCalledWith, "createJob must have been called with params");
  assert.equal(createJobCalledWith!.prompt, "a cinematic test scene");
  assert.equal(createJobCalledWith!.modelId, "test-model-v1");

  // externalJobId persisted in store
  assert.equal(jobs.get(job.id as string)?.externalJobId, "ext-scenario-1");

  // Status became submitted
  assert.equal(result?.status, "submitted");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 2: submit provider failure → failed, error persisted, no externalJobId
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 2: submit provider failure transitions job to failed", async () => {
  const mockProvider = makeMockVideoProvider({
    createJobResult: async () => {
      throw new Error("Provider rejected: quota exceeded");
    },
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({ status: "queued", providerId: provider.id, modelId: model.id });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const result = await executor.submitJob(job.id as string);

  // Status became failed
  assert.equal(result?.status, "failed");

  // Error persisted
  const persisted = jobs.get(job.id as string);
  assert.ok(persisted?.error, "error must be persisted");
  assert.match(persisted!.error as string, /quota exceeded/);

  // No externalJobId set
  assert.equal(persisted?.externalJobId, null);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 3: poll submitted → processing, progress persisted
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 3: poll submitted → processing with progress", async () => {
  const mockProvider = makeMockVideoProvider({
    getJobStatusSequence: [{ status: "processing", progress: 42 }],
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "submitted",
    providerId: provider.id,
    modelId: model.id,
    externalJobId: "ext-scenario-3",
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const result = await executor.pollJob(job.id as string);

  assert.equal(result?.status, "processing");
  assert.equal(jobs.get(job.id as string)?.progress, 42);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 4: poll processing → completed, resultUrl preserved in metadata
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 4: poll processing → completed with resultUrl in metadata", async () => {
  const mockProvider = makeMockVideoProvider({
    getJobStatusSequence: [
      {
        status: "completed",
        progress: 100,
        resultUrl: "https://cdn.example.com/videos/output.mp4",
        metadata: { rawStatus: "SUCCEEDED" },
      },
    ],
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "processing",
    providerId: provider.id,
    modelId: model.id,
    externalJobId: "ext-scenario-4",
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const result = await executor.pollJob(job.id as string);

  assert.equal(result?.status, "completed");
  assert.equal(jobs.get(job.id as string)?.progress, 100);

  // resultUrl must be in metadata
  const meta = jobs.get(job.id as string)?.metadata as Record<string, unknown> | null;
  assert.ok(meta, "metadata must be set");
  assert.equal(meta?.resultUrl, "https://cdn.example.com/videos/output.mp4");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 5: poll provider failure → status becomes failed, error preserved
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 5: poll provider failure → failed with error", async () => {
  const mockProvider = makeMockVideoProvider({
    getJobStatusSequence: [
      { status: "failed", error: "Rendering engine crashed" },
    ],
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "processing",
    providerId: provider.id,
    modelId: model.id,
    externalJobId: "ext-scenario-5",
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const result = await executor.pollJob(job.id as string);

  assert.equal(result?.status, "failed");
  const persisted = jobs.get(job.id as string);
  assert.ok(persisted?.error, "provider error must be persisted");
  assert.match(persisted!.error as string, /Rendering engine crashed/);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 6: invalid submit from non-queued statuses
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 6: invalid submit from non-queued status throws ExecutorInvalidStateError", async () => {
  const mockProvider = makeMockVideoProvider({});
  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);

  providers.set(provider.id, provider);
  models.set(model.id, model);

  for (const status of ["submitted", "processing", "completed", "failed", "cancelled"]) {
    const job = makeJob({
      status,
      providerId: provider.id,
      modelId: model.id,
      externalJobId: `ext-6-${status}`,
    });
    jobs.set(job.id as string, job);

    await assert.rejects(
      () => executor.submitJob(job.id as string),
      (err: unknown) => {
        assert.ok(
          err instanceof ExecutorInvalidStateError,
          `Expected ExecutorInvalidStateError for status "${status}", got ${(err as any)?.constructor?.name}: ${(err as any)?.message}`,
        );
        assert.match(err.message, new RegExp(status));
        return true;
      },
    );
  }

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 7: polling without externalJobId rejected
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 7: pollJob without externalJobId throws ExecutorConfigError", async () => {
  const mockProvider = makeMockVideoProvider({});
  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "submitted",
    providerId: provider.id,
    modelId: model.id,
    externalJobId: null, // deliberately missing
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  await assert.rejects(
    () => executor.pollJob(job.id as string),
    (err: unknown) => {
      assert.ok(
        err instanceof ExecutorConfigError,
        `Expected ExecutorConfigError, got ${(err as any)?.constructor?.name}: ${(err as any)?.message}`,
      );
      assert.match(err.message, /externalJobId/);
      return true;
    },
  );

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 8: deterministic bounded polling — processing, processing, completed
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 8: bounded poll stops at completed; injected sleep; no real waiting", async () => {
  let sleepCallCount = 0;
  const noopSleep = async (_ms: number) => { sleepCallCount++; };

  const mockProvider = makeMockVideoProvider({
    createJobResult: async () => ({ externalJobId: "ext-scenario-8" }),
    getJobStatusSequence: [
      { status: "processing", progress: 20 },
      { status: "processing", progress: 60 },
      { status: "completed", progress: 100, resultUrl: "https://cdn.example.com/s8.mp4" },
    ],
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "queued",
    providerId: provider.id,
    modelId: model.id,
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const result = await executor.runBoundedPoll(job.id as string, {
    maxPolls: 10,
    pollIntervalMs: 1000,
    sleep: noopSleep,
  });

  // Stopped at completed
  assert.equal(result?.status, "completed");

  // Sleep was called exactly 3 times (processing, processing, completed = 3 polls)
  assert.equal(sleepCallCount, 3, `Expected 3 sleep calls, got ${sleepCallCount}`);

  // resultUrl in metadata
  const meta = jobs.get(job.id as string)?.metadata as Record<string, unknown> | null;
  assert.ok(meta, "metadata must be set after completed poll");
  assert.equal(meta?.resultUrl, "https://cdn.example.com/s8.mp4");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 9: bounded polling timeout — reaches maxPolls, job remains processing
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 9: bounded poll timeout — reaches maxPolls, job remains processing", async () => {
  let sleepCallCount = 0;
  const noopSleep = async (_ms: number) => { sleepCallCount++; };

  // Provider always returns processing (single entry repeated via sequence logic)
  const mockProvider = makeMockVideoProvider({
    createJobResult: async () => ({ externalJobId: "ext-scenario-9" }),
    getJobStatusSequence: [{ status: "processing", progress: 50 }],
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "queued",
    providerId: provider.id,
    modelId: model.id,
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const maxPolls = 5;
  const result = await executor.runBoundedPoll(job.id as string, {
    maxPolls,
    pollIntervalMs: 100,
    sleep: noopSleep,
  });

  // Job remains processing — no new status invented
  assert.equal(result?.status, "processing");

  // Slept exactly maxPolls times
  assert.equal(sleepCallCount, maxPolls, `Expected ${maxPolls} sleep calls, got ${sleepCallCount}`);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 10: no real ChatFire network calls in tests
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 10: no real ChatFire network calls anywhere in executor tests", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  (globalThis as any).fetch = async (..._args: unknown[]) => {
    fetchCalled = true;
    throw new Error("REAL FETCH CALLED — ChatFire must not be invoked in executor tests");
  };

  try {
    const mockProvider = makeMockVideoProvider({
      createJobResult: async () => ({ externalJobId: "ext-scenario-10" }),
      getJobStatusSequence: [{ status: "processing", progress: 50 }],
    });

    const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

    const provider = makeProvider();
    const model = makeModel(provider.id);
    const job = makeJob({
      status: "queued",
      providerId: provider.id,
      modelId: model.id,
    });

    providers.set(provider.id, provider);
    models.set(model.id, model);
    jobs.set(job.id as string, job);

    // Submit: moves queued → submitted, sets externalJobId
    const submitResult = await executor.submitJob(job.id as string);
    assert.equal(submitResult?.status, "submitted");

    // Poll: moves submitted → processing (valid transition)
    const pollResult = await executor.pollJob(job.id as string);
    assert.equal(pollResult?.status, "processing");

    // Verify no real fetch occurred anywhere
    assert.equal(fetchCalled, false, "No real fetch must be called during executor tests");

    teardown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Scenario 11 (Fix 1): provider returns completed while Icooro job is submitted
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 11 (Fix 1): provider returns completed from submitted status", async () => {
  let getJobStatusCallCount = 0;

  const mockProvider = makeMockVideoProvider({
    getJobStatusSequence: [
      {
        status: "completed",
        progress: 100,
        resultUrl: "https://cdn.example.com/s11.mp4",
        metadata: { rawStatus: "SUCCEEDED" },
      },
    ],
  });

  // Track getJobStatus call count
  const origGetStatus = mockProvider.getJobStatus.bind(mockProvider);
  mockProvider.getJobStatus = async (id: string) => {
    getJobStatusCallCount++;
    return origGetStatus(id);
  };

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "submitted",           // Icooro is submitted
    providerId: provider.id,
    modelId: model.id,
    externalJobId: "ext-scenario-11",
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  const result = await executor.pollJob(job.id as string);

  // Final status must be completed
  assert.equal(result?.status, "completed", "final status must be completed");

  // Progress and resultUrl must be preserved in metadata
  assert.equal(jobs.get(job.id as string)?.progress, 100);
  const meta = jobs.get(job.id as string)?.metadata as Record<string, unknown> | null;
  assert.ok(meta, "metadata must be set");
  assert.equal(meta?.resultUrl, "https://cdn.example.com/s11.mp4");

  // Provider was called exactly once — no second provider poll
  assert.equal(getJobStatusCallCount, 1, "provider.getJobStatus must be called exactly once");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 12 (Fix 2): polling terminal jobs is rejected before calling provider
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 12 (Fix 2): polling terminal jobs throws ExecutorInvalidStateError", async () => {
  let getJobStatusCallCount = 0;

  const mockProvider = makeMockVideoProvider({
    getJobStatusSequence: [{ status: "processing", progress: 50 }],
  });

  const origGetStatus = mockProvider.getJobStatus.bind(mockProvider);
  mockProvider.getJobStatus = async (id: string) => {
    getJobStatusCallCount++;
    return origGetStatus(id);
  };

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);

  providers.set(provider.id, provider);
  models.set(model.id, model);

  for (const terminalStatus of ["completed", "failed", "cancelled"] as const) {
    const job = makeJob({
      status: terminalStatus,
      providerId: provider.id,
      modelId: model.id,
      externalJobId: `ext-s12-${terminalStatus}`,
    });
    jobs.set(job.id as string, job);

    await assert.rejects(
      () => executor.pollJob(job.id as string),
      (err: unknown) => {
        assert.ok(
          err instanceof ExecutorInvalidStateError,
          `Expected ExecutorInvalidStateError for terminal status "${terminalStatus}", got ${(err as any)?.constructor?.name}: ${(err as any)?.message}`,
        );
        assert.match(err.message, new RegExp(terminalStatus));
        return true;
      },
    );
  }

  // Provider.getJobStatus must never have been called
  assert.equal(
    getJobStatusCallCount,
    0,
    `provider.getJobStatus must not be called for terminal jobs; was called ${getJobStatusCallCount} time(s)`,
  );

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 13 (Fix 3): concurrent submitJob() calls — only one provider job created
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 13 (Fix 3): concurrent submitJob() calls create only one provider job", async () => {
  let createJobCallCount = 0;

  // Use a promise-based gate so the first createJob() suspends long enough
  // for the second submitJob() call to start and be rejected before the
  // first one resolves. This makes the race deterministic.
  let releaseLatch!: () => void;
  const latch = new Promise<void>((resolve) => { releaseLatch = resolve; });

  const mockProvider = makeMockVideoProvider({
    createJobResult: async () => {
      createJobCallCount++;
      // Suspend until the test releases the latch
      await latch;
      return { externalJobId: "ext-scenario-13-only-one", metadata: { engine: "test" } };
    },
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "queued",
    providerId: provider.id,
    modelId: model.id,
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  // Start first submission — it will suspend at the latch inside createJob
  const firstPromise = executor.submitJob(job.id as string);

  // Start second submission concurrently — the in-process guard must reject it
  const secondPromise = executor.submitJob(job.id as string);

  // The second call must be rejected immediately (before the first resolves)
  await assert.rejects(
    () => secondPromise,
    (err: unknown) => {
      assert.ok(
        err instanceof ExecutorInvalidStateError,
        `Expected ExecutorInvalidStateError from concurrent guard, got ${(err as any)?.constructor?.name}: ${(err as any)?.message}`,
      );
      assert.match(err.message, /concurrent/i);
      return true;
    },
  );

  // Now release the latch so the first submission can complete
  releaseLatch();
  const firstResult = await firstPromise;

  // First submission succeeded with submitted status
  assert.equal(firstResult?.status, "submitted");

  // provider.createJob was called exactly once
  assert.equal(createJobCallCount, 1, `provider.createJob must be called exactly once; was called ${createJobCallCount} time(s)`);

  // The single externalJobId from the provider is persisted
  assert.equal(
    jobs.get(job.id as string)?.externalJobId,
    "ext-scenario-13-only-one",
  );

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario 14 (Fix 4): credential-bearing error messages are redacted
// ---------------------------------------------------------------------------

test("GenerationExecutor - Scenario 14 (Fix 4): credential material in error messages is redacted before storage", async () => {
  const credentialError = new Error(
    "ChatFire submission failed: Authorization: Bearer sk-super-secret-token-12345 was rejected. " +
    "Also tried apiKey=myPrivateKey123 and password=hunter2 but got HTTP 403.",
  );

  const mockProvider = makeMockVideoProvider({
    createJobResult: async () => { throw credentialError; },
  });

  const { jobs, providers, models, executor, teardown } = setupTest(mockProvider);

  const provider = makeProvider();
  const model = makeModel(provider.id);
  const job = makeJob({
    status: "queued",
    providerId: provider.id,
    modelId: model.id,
  });

  providers.set(provider.id, provider);
  models.set(model.id, model);
  jobs.set(job.id as string, job);

  // submitJob() catches the provider error and stores the safe message
  const result = await executor.submitJob(job.id as string);

  assert.equal(result?.status, "failed");

  const storedError = jobs.get(job.id as string)?.error as string;
  assert.ok(storedError, "error must be persisted");

  // Bearer token must not appear in stored error
  assert.doesNotMatch(
    storedError,
    /sk-super-secret-token/i,
    "Bearer token must not appear in stored error",
  );
  assert.doesNotMatch(
    storedError,
    /myPrivateKey123/,
    "apiKey value must not appear in stored error",
  );
  assert.doesNotMatch(
    storedError,
    /hunter2/,
    "password value must not appear in stored error",
  );

  // Redaction placeholders must be present
  assert.match(storedError, /\[redacted\]/i, "redaction placeholder must be present");

  // Error must still be bounded
  assert.ok(storedError.length <= 500, `stored error must be ≤500 chars; got ${storedError.length}`);

  teardown();
});

