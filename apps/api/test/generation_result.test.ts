/**
 * C5.3 – Generation Result Download & AssetVersion Persistence Tests
 *
 * All tests use:
 *   - In-memory fake DB (setDb) — no real MySQL
 *   - Fake StorageProvider (setStorageProvider) — no filesystem I/O
 *   - Inline VideoProvider mock with downloadResult() — no real ChatFire calls
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb, setDb } from "../src/db/index.js";
import { setStorageProvider } from "../src/storage/index.js";
import { providerRegistry } from "../src/providers/registry.js";
import {
  GenerationResultService,
  ResultJobNotFoundError,
  ResultOwnershipError,
  ResultInvalidStateError,
  ResultConfigError,
  ResultAlreadyPersistedError,
  ResultDownloadError,
  ResultStorageError,
} from "../src/services/generation_result.js";
import type {
  VideoProvider,
  VideoGenerationParams,
  MediaDownloadResult,
} from "../src/providers/types.js";
import type { StorageProvider, StoragePutResult, StorageMetadata } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// Drizzle internals helpers (same pattern as executor tests)
// ---------------------------------------------------------------------------

const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name");

function extractEqValue(cond: unknown): string | null {
  const chunks = (cond as any)?.queryChunks;
  if (!Array.isArray(chunks) || chunks.length < 4) return null;
  return chunks[3]?.value ?? null;
}

/**
 * Walk a Drizzle predicate and return the first `eq(table, value)` value
 * found. Used by the fake DB to support composite predicates such as
 * `and(eq(aiJobs.id, jobId), isNull(aiJobs.assetVersionId))`.
 */
function extractEqFromPredicate(cond: unknown): string | null {
  if (!cond) return null;
  const direct = extractEqValue(cond);
  if (direct != null) return direct;
  const chunks = (cond as any)?.queryChunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) {
      const v = extractEqFromPredicate(c);
      if (v != null) return v;
    }
  }
  return null;
}

function tableNameOf(table: unknown): string {
  return (table as any)?.[DRIZZLE_TABLE_NAME] ?? "";
}

// ---------------------------------------------------------------------------
// Fake DB — supports jobs, providers, assets, assetVersions
// ---------------------------------------------------------------------------

interface FakeStores {
  jobs: Map<string, Record<string, unknown>>;
  providers: Map<string, Record<string, unknown>>;
  assets: Map<string, Record<string, unknown>>;
  versions: Map<string, Record<string, unknown>>;
}

function makeFakeDb(stores: FakeStores) {
  function resolveStore(tableName: string): Map<string, Record<string, unknown>> {
    if (tableName === "ai_providers") return stores.providers;
    if (tableName === "assets") return stores.assets;
    if (tableName === "asset_versions") return stores.versions;
    return stores.jobs; // ai_jobs default
  }

  // Track inserted assetVersions so we can return their id
  let insertedVersionId: string | null = null;

  // Shared operations object — `db` and any `tx` (transaction) both
  // delegate to this so writes made inside a transaction are visible
  // to subsequent reads. (This is a single-process test fake; it does
  // not need real MVCC.)
  const ops = {
    select() {
      return {
        from(table: unknown) {
          const storeName = tableNameOf(table);
          // Build a thenable that supports both `await` and
          // `.for("update")` (Drizzle's row-locking API). `.for()` is
          // a no-op for the fake because the serialized `txChain`
          // below already prevents concurrent transactions from
          // interleaving; the chain must simply return a thenable
          // so the production code can call `.for("update")` on it.
          const buildChain = (cond?: unknown) => {
            const resolveRows = () => {
              const id = cond != null ? extractEqFromPredicate(cond) : null;
              const store = resolveStore(storeName);
              const row = id ? store.get(id) : undefined;
              return Promise.resolve(row ? [{ ...row }] : []);
            };
            const thenable: any = {
              for(_strength: string, _config?: unknown) {
                return buildChain(cond);
              },
              where(cond2: unknown) {
                return buildChain(cond2);
              },
              then(resolve: any, reject?: any) {
                return resolveRows().then(resolve, reject);
              },
            };
            return thenable;
          };
          return {
            where(cond: unknown) {
              return buildChain(cond);
            },
            then(resolve: any, reject?: any) {
              return Promise.resolve([]).then(resolve, reject);
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
              const id = extractEqFromPredicate(cond);
              if (id) {
                const store = resolveStore(storeName);
                const existing = store.get(id);
                if (existing) {
                  // Simulate the `WHERE asset_version_id IS NULL` predicate
                  // used by `completeJobWithAssetVersion` for the
                  // concurrency guard: if the update payload would set
                  // `assetVersionId` and the row already has a non-null
                  // value, behave as if affectedRows = 0.
                  if (
                    Object.prototype.hasOwnProperty.call(values, "assetVersionId") &&
                    existing.assetVersionId != null
                  ) {
                    return Promise.resolve({ affectedRows: 0 });
                  }
                  Object.assign(existing, values);
                  return Promise.resolve({ affectedRows: 1 });
                }
                return Promise.resolve({ affectedRows: 0 });
              }
              return Promise.resolve({ affectedRows: 0 });
            },
          };
        },
      };
    },

    insert(table: unknown) {
      const storeName = tableNameOf(table);
      return {
        values(vals: Record<string, unknown>) {
          // Generate an id and store the row for assetVersions
          const newId = randomUUID();
          if (storeName === "asset_versions") {
            insertedVersionId = newId;
            stores.versions.set(newId, { id: newId, ...vals });
          }
          return {
            $returningId() {
              return Promise.resolve(newId ? [{ id: newId }] : []);
            },
          };
        },
      };
    },
  };

  // Serialized transaction queue. The real MySQL semantics we are
  // simulating is "one transaction at a time per connection, with
  // commit/rollback being atomic and isolated from other transactions
  // until they complete". Without serialization, two concurrent fake
  // transactions would interleave and a rollback in the loser would
  // wipe the winner's uncommitted writes.
  let txChain: Promise<unknown> = Promise.resolve();

  const fakeDb: any = {
    select: ops.select,
    update: ops.update,
    insert: ops.insert,
    transaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        // Snapshot all mutable stores so we can roll back on throw.
        const snapshot = {
          jobs: new Map(stores.jobs),
          providers: new Map(stores.providers),
          assets: new Map(stores.assets),
          versions: new Map(stores.versions),
          insertedVersionId,
        };
        try {
          return await cb(fakeDb);
        } catch (err) {
          stores.jobs.clear();
          stores.providers.clear();
          stores.assets.clear();
          stores.versions.clear();
          for (const [k, v] of snapshot.jobs) stores.jobs.set(k, v);
          for (const [k, v] of snapshot.providers) stores.providers.set(k, v);
          for (const [k, v] of snapshot.assets) stores.assets.set(k, v);
          for (const [k, v] of snapshot.versions) stores.versions.set(k, v);
          insertedVersionId = snapshot.insertedVersionId;
          throw err;
        }
      };
      const next = txChain.then(run, run);
      // Swallow errors in the chain so one rejection doesn't break
      // later transactions; the original promise returned to the
      // caller still rejects.
      txChain = next.catch(() => undefined);
      return next;
    },
  };

  // Expose helper to read last inserted version id (for assertions)
  (fakeDb as any).__getLastVersionId = () => insertedVersionId;

  return fakeDb;
}

// ---------------------------------------------------------------------------
// Fake StorageProvider
// ---------------------------------------------------------------------------

interface FakeStorageState {
  stored: Map<string, { data: Buffer; mimeType?: string }>;
  shouldFail?: boolean;
  failMessage?: string;
  // Failures for the cleanup-delete path; if set, delete() will throw.
  deleteShouldFail?: boolean;
  deleteFailMessage?: string;
  // Records every delete(key) call so tests can assert it happened.
  deleteCalls: string[];
}

function makeFakeStorageProvider(state: FakeStorageState): StorageProvider {
  state.deleteCalls ??= [];
  return {
    async put(key: string, data: Buffer | Uint8Array | string, options?: { mimeType?: string }): Promise<StoragePutResult> {
      if (state.shouldFail) {
        throw new Error(state.failMessage ?? "Storage write failed");
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      state.stored.set(key, { data: buf, mimeType: options?.mimeType });
      return { key, size: buf.byteLength };
    },
    async get(key: string): Promise<Buffer> {
      const entry = state.stored.get(key);
      if (!entry) throw new Error(`Key not found: ${key}`);
      return entry.data;
    },
    async exists(key: string): Promise<boolean> {
      return state.stored.has(key);
    },
    async delete(key: string): Promise<boolean> {
      state.deleteCalls.push(key);
      if (state.deleteShouldFail) {
        throw new Error(state.deleteFailMessage ?? "Storage delete failed");
      }
      return state.stored.delete(key);
    },
    async getMetadata(key: string): Promise<StorageMetadata | null> {
      const entry = state.stored.get(key);
      if (!entry) return null;
      return { size: entry.data.byteLength, lastModified: new Date(), mimeType: entry.mimeType };
    },
    async getUrl(key: string): Promise<string> {
      return `/api/v1/storage/${key}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake VideoProvider
// ---------------------------------------------------------------------------

const RESULT_PROVIDER_TYPE = "test-result-mock";

interface DownloadOpts {
  result?: MediaDownloadResult;
  shouldFail?: boolean;
  failMessage?: string;
}

function makeMockProviderWithDownload(opts: DownloadOpts): VideoProvider {
  return {
    providerType: RESULT_PROVIDER_TYPE,
    name: "Result Test Provider",
    capabilities: ["video"] as const,
    async testConnection() { return { ok: true }; },
    async createJob(_: VideoGenerationParams) {
      return { externalJobId: `ext-${randomUUID()}` };
    },
    async getJobStatus(_: string) { return { status: "completed", progress: 100 }; },
    async cancelJob(_: string) { return { cancelled: true }; },
    async downloadResult(_: string): Promise<MediaDownloadResult> {
      if (opts.shouldFail) throw new Error(opts.failMessage ?? "Download failed");
      return opts.result ?? {
        data: Buffer.from("fake-video-bytes"),
        mimeType: "video/mp4",
        fileExtension: "mp4",
        fileSize: 16,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeProvider(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: randomUUID(),
    name: "Test Provider",
    providerType: RESULT_PROVIDER_TYPE,
    enabled: true,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAsset(projectId: string, overrides?: Partial<Record<string, unknown>>) {
  return {
    id: randomUUID(),
    projectId,
    name: "Generated Video",
    type: "video",
    status: "draft",
    approvedVersionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeJob(overrides?: Partial<Record<string, unknown>>) {
  const projectId = overrides?.projectId as string ?? randomUUID();
  return {
    id: randomUUID(),
    jobType: "video",
    status: "completed",
    projectId,
    providerId: null as string | null,
    modelId: "model-uuid-1",
    externalJobId: `ext-${randomUUID()}`,
    assetId: null as string | null,
    assetVersionId: null as string | null,
    prompt: "a cinematic test scene",
    negativePrompt: null,
    targetMediaType: "video",
    requestedDuration: 5,
    requestedWidth: 1920,
    requestedHeight: 1080,
    progress: 100,
    error: null as string | null,
    metadata: { resultUrl: "https://cdn.provider.example/result.mp4" } as Record<string, unknown> | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

interface SetupResult {
  stores: FakeStores;
  storageState: FakeStorageState;
  service: GenerationResultService;
  teardown: () => void;
}

function setupTest(mockProvider: VideoProvider, storageState?: Partial<FakeStorageState>): SetupResult {
  const stores: FakeStores = {
    jobs: new Map(),
    providers: new Map(),
    assets: new Map(),
    versions: new Map(),
  };

  const storage: FakeStorageState = {
    stored: new Map(),
    shouldFail: false,
    ...storageState,
  };

  const fakeDb = makeFakeDb(stores);
  setDb(fakeDb);

  const fakeStorage = makeFakeStorageProvider(storage);
  setStorageProvider(fakeStorage);

  providerRegistry.register(mockProvider);
  const service = new GenerationResultService();

  function teardown() {
    providerRegistry.unregister(mockProvider.providerType);
    setStorageProvider(null);
    setDb(null as any);
  }

  return { stores, storageState: storage, service, teardown };
}

// ---------------------------------------------------------------------------
// Scenario A: Completed job → downloaded → stored → AssetVersion created
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario A: completed job persists to storage and creates AssetVersion", async () => {
  const mock = makeMockProviderWithDownload({
    result: {
      data: Buffer.from("video-bytes-content"),
      mimeType: "video/mp4",
      fileExtension: "mp4",
      fileSize: 19,
    },
  });

  const { stores, storageState, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  const version = await service.persistResult(job.id as string, projectId);

  // AssetVersion returned
  assert.ok(version, "AssetVersion must be returned");
  assert.ok(version.id, "AssetVersion must have an id");
  assert.equal(version.assetId, asset.id);
  assert.equal(version.sourceKind, "generated");
  assert.equal(version.mimeType, "video/mp4");
  assert.equal(version.fileExtension, "mp4");
  assert.equal(version.status, "ready");

  // Storage key is project-scoped and deterministic
  const expectedKey = `generated/${projectId}/${job.id}/${job.id}.mp4`;
  assert.equal(version.storageKey, expectedKey);
  assert.ok(storageState.stored.has(expectedKey), "File must be in storage");

  // Stored bytes match
  const stored = storageState.stored.get(expectedKey)!;
  assert.equal(stored.data.toString(), "video-bytes-content");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario B: Correct AssetVersion/job association
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario B: AssetVersion is linked to job via jobId field", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  const version = await service.persistResult(job.id as string, projectId);

  assert.ok(version, "AssetVersion must be returned");
  // jobId column links back to the generation job
  assert.equal(version.jobId, job.id, "AssetVersion.jobId must match the generation job ID");

  // The job's assetVersionId must be updated
  const persistedJob = stores.jobs.get(job.id as string);
  assert.ok(persistedJob?.assetVersionId, "job.assetVersionId must be set after persist");
  assert.equal(persistedJob?.assetVersionId, version.id);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario C: Existing Asset is reused when assetId is present
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario C: existing Asset is reused; no new Asset created", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const existingAsset = makeAsset(projectId, { name: "Existing Cinematic Asset" });
  const job = makeJob({ projectId, providerId: provider.id, assetId: existingAsset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(existingAsset.id as string, existingAsset);
  stores.jobs.set(job.id as string, job);

  const assetCountBefore = stores.assets.size;

  const version = await service.persistResult(job.id as string, projectId);

  // No new assets created
  assert.equal(stores.assets.size, assetCountBefore, "No new Asset must be created");
  assert.equal(version?.assetId, existingAsset.id, "AssetVersion must point to the existing asset");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario D: Provider download failure
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario D: provider download failure throws ResultDownloadError", async () => {
  const mock = makeMockProviderWithDownload({
    shouldFail: true,
    failMessage: "Remote CDN unreachable",
  });

  const { stores, storageState, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  await assert.rejects(
    () => service.persistResult(job.id as string, projectId),
    (err: unknown) => {
      assert.ok(err instanceof ResultDownloadError, `Expected ResultDownloadError, got ${(err as any)?.constructor?.name}`);
      assert.match(err.message, /CDN unreachable/);
      return true;
    },
  );

  // No file stored
  assert.equal(storageState.stored.size, 0, "Nothing must be stored on download failure");

  // No AssetVersion created
  assert.equal(stores.versions.size, 0, "No AssetVersion must be created on download failure");

  // Job assetVersionId unchanged
  assert.equal(stores.jobs.get(job.id as string)?.assetVersionId, null);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario E: Storage failure
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario E: storage failure throws ResultStorageError", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, service, teardown } = setupTest(mock, {
    shouldFail: true,
    failMessage: "Disk full",
  });

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  await assert.rejects(
    () => service.persistResult(job.id as string, projectId),
    (err: unknown) => {
      assert.ok(err instanceof ResultStorageError, `Expected ResultStorageError, got ${(err as any)?.constructor?.name}`);
      assert.match(err.message, /Disk full/);
      return true;
    },
  );

  // No AssetVersion created
  assert.equal(stores.versions.size, 0, "No AssetVersion must be created on storage failure");
  assert.equal(stores.jobs.get(job.id as string)?.assetVersionId, null);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario F: Missing resultUrl in job metadata
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario F: missing resultUrl in metadata throws ResultConfigError", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({
    projectId,
    providerId: provider.id,
    assetId: asset.id,
    metadata: {}, // no resultUrl
  });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  await assert.rejects(
    () => service.persistResult(job.id as string, projectId),
    (err: unknown) => {
      assert.ok(err instanceof ResultConfigError, `Expected ResultConfigError, got ${(err as any)?.constructor?.name}`);
      assert.match(err.message, /resultUrl/);
      return true;
    },
  );

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario G: Non-completed job rejected
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario G: non-completed jobs are rejected with ResultInvalidStateError", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);

  for (const status of ["queued", "submitted", "processing", "failed", "cancelled"]) {
    const job = makeJob({
      projectId,
      providerId: provider.id,
      assetId: asset.id,
      status,
      // ensure externalJobId is present so the status check fires, not missing config
      externalJobId: `ext-${status}`,
    });
    stores.jobs.set(job.id as string, job);

    await assert.rejects(
      () => service.persistResult(job.id as string, projectId),
      (err: unknown) => {
        assert.ok(
          err instanceof ResultInvalidStateError,
          `Expected ResultInvalidStateError for status "${status}", got ${(err as any)?.constructor?.name}: ${(err as any)?.message}`,
        );
        assert.match(err.message, new RegExp(status));
        return true;
      },
    );
  }

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario H: Wrong-project job rejected
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario H: wrong-project job rejected with ResultOwnershipError", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, service, teardown } = setupTest(mock);

  const realProjectId = randomUUID();
  const otherProjectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(realProjectId);
  const job = makeJob({ projectId: realProjectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  await assert.rejects(
    () => service.persistResult(job.id as string, otherProjectId), // wrong project
    (err: unknown) => {
      assert.ok(err instanceof ResultOwnershipError, `Expected ResultOwnershipError, got ${(err as any)?.constructor?.name}`);
      return true;
    },
  );

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario I: Idempotency — repeated persist-result does not create duplicate
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario I: repeated persist-result is idempotent — throws ResultAlreadyPersistedError", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  // Simulate a job that was already persisted: assetVersionId is already set
  const existingVersionId = randomUUID();
  const job = makeJob({
    projectId,
    providerId: provider.id,
    assetId: asset.id,
    assetVersionId: existingVersionId, // already persisted
  });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);
  // The version row exists
  stores.versions.set(existingVersionId, {
    id: existingVersionId,
    assetId: asset.id,
    jobId: job.id,
    version: 1,
    status: "ready",
    sourceKind: "generated",
    storageKey: `generated/${projectId}/${job.id}/${job.id}.mp4`,
    mimeType: "video/mp4",
  });

  await assert.rejects(
    () => service.persistResult(job.id as string, projectId),
    (err: unknown) => {
      assert.ok(
        err instanceof ResultAlreadyPersistedError,
        `Expected ResultAlreadyPersistedError, got ${(err as any)?.constructor?.name}: ${(err as any)?.message}`,
      );
      assert.match(err.message, new RegExp(existingVersionId));
      return true;
    },
  );

  // Still only one version in the store (the pre-existing one)
  assert.equal(stores.versions.size, 1, "No duplicate AssetVersion must be created");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario J: Sanitized errors do not leak credentials or provider URLs
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario J: download errors with credentials are sanitized", async () => {
  const mock = makeMockProviderWithDownload({
    shouldFail: true,
    failMessage:
      "ChatFire download rejected: Authorization: Bearer sk-secret-api-key-9999 at https://cdn.chatfire.internal/result?token=mysecrettoken123",
  });

  const { stores, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  await assert.rejects(
    () => service.persistResult(job.id as string, projectId),
    (err: unknown) => {
      assert.ok(err instanceof ResultDownloadError);
      const msg = err.message;
      // Bearer token must not appear
      assert.doesNotMatch(msg, /sk-secret-api-key/i, "Bearer token must not appear in error");
      // Token query param must not appear
      assert.doesNotMatch(msg, /mysecrettoken123/, "token= value must not appear in error");
      // Full URL must not appear
      assert.doesNotMatch(msg, /cdn\.chatfire\.internal/, "Provider URL must not appear in error");
      // Error must be bounded
      assert.ok(msg.length <= 600, `Error too long: ${msg.length} chars`);
      return true;
    },
  );

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario K: Storage key is project-scoped and traversal-safe
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario K: storage key is project-scoped and deterministic", async () => {
  const mock = makeMockProviderWithDownload({
    result: {
      data: Buffer.from("test"),
      mimeType: "video/webm",
      fileExtension: "webm",
    },
  });

  const { stores, storageState, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  const version = await service.persistResult(job.id as string, projectId);

  const key = version?.storageKey as string;

  // Key starts with generated/
  assert.ok(key.startsWith("generated/"), `Key must start with generated/, got: ${key}`);

  // Key contains projectId as a path segment
  assert.ok(key.includes(projectId), "Key must contain projectId");

  // Key contains jobId as a path segment
  assert.ok(key.includes(job.id as string), "Key must contain jobId");

  // No traversal segments
  assert.doesNotMatch(key, /\.\./, "Key must not contain '..'");
  assert.doesNotMatch(key, /^\//, "Key must not start with /");

  // Extension derived from mimeType
  assert.ok(key.endsWith(".webm"), `Key must end with .webm, got: ${key}`);

  // Stored in fake storage under that key
  assert.ok(storageState.stored.has(key), "File must be stored under the computed key");

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario L: Concurrent persistResult — exactly one wins, the loser sees
//            ResultAlreadyPersistedError. Regression for the C5.3
//            DB-level idempotency guarantee.
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario L: concurrent persistResult yields exactly one AssetVersion", async () => {
  const mock = makeMockProviderWithDownload({});

  const { stores, storageState, service, teardown } = setupTest(mock);

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  // Block both `storage.put` calls on a shared gate so that the two
  // `persistResult` invocations are guaranteed to be in flight at the
  // same time when we release the gate. This is a real concurrency
  // regression: not a sequential test.
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const originalPut = storageState.stored;
  const realPut = (key: string, data: Buffer | Uint8Array | string, options?: { mimeType?: string }) => {
    return gate.then(() => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      originalPut.set(key, { data: buf, mimeType: options?.mimeType });
      return { key, size: buf.byteLength };
    });
  };
  // Replace the storage put on the registered provider via a fresh
  // storage object that wraps the original Map but uses our gated put.
  const gatedStorage: StorageProvider = {
    put: realPut as any,
    async get(key: string) {
      const entry = originalPut.get(key);
      if (!entry) throw new Error(`Key not found: ${key}`);
      return entry.data;
    },
    async exists(key: string) { return originalPut.has(key); },
    async delete(key: string) {
      storageState.deleteCalls.push(key);
      return originalPut.delete(key);
    },
    async getMetadata(key: string) {
      const entry = originalPut.get(key);
      if (!entry) return null;
      return { size: entry.data.byteLength, lastModified: new Date(), mimeType: entry.mimeType };
    },
    async getUrl(key: string) { return `/api/v1/storage/${key}`; },
  };
  setStorageProvider(gatedStorage);

  // Fire both calls concurrently. They both block at storage.put.
  const callA = service.persistResult(job.id as string, projectId);
  const callB = service.persistResult(job.id as string, projectId);

  // Give both calls a chance to reach the gated put.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // Release the gate: both puts resolve in microtask order, both then
  // enter `completeJobWithAssetVersion`. The first to run its
  // conditional UPDATE wins; the second sees `affectedRows = 0` and
  // throws `JobAlreadyLinkedError`, which is translated to
  // `ResultAlreadyPersistedError`.
  releaseGate();

  const [resA, resB] = await Promise.allSettled([callA, callB]);

  // Exactly one fulfilled, one rejected.
  const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
  const rejected = [resA, resB].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "Exactly one persistResult must succeed");
  assert.equal(rejected.length, 1, "Exactly one persistResult must be rejected");

  // The winning call returns a real AssetVersion.
  const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
  assert.ok(winner?.id, "Winner must return an AssetVersion with an id");

  // The losing call rejects with ResultAlreadyPersistedError.
  const loserErr = (rejected[0] as PromiseRejectedResult<any>).reason;
  assert.ok(
    loserErr instanceof ResultAlreadyPersistedError,
    `Loser must reject with ResultAlreadyPersistedError, got ${loserErr?.constructor?.name}: ${loserErr?.message}`,
  );
  // The loser's error references the winning AssetVersion id.
  assert.match(loserErr.message, new RegExp(winner.id));

  // Exactly ONE AssetVersion row exists in the store.
  assert.equal(stores.versions.size, 1, "Exactly one AssetVersion must be created");

  // The job has exactly one assetVersionId set, and it is the winner's id.
  const persistedJob = stores.jobs.get(job.id as string);
  assert.equal(persistedJob?.assetVersionId, winner.id, "job.assetVersionId must be the winner's id");
  assert.ok(persistedJob?.assetVersionId, "job.assetVersionId must be set");

  // Only one storage key was used. The storage key is deterministic
  // from jobId, so the winner's bytes are what remain on disk; the
  // loser MUST NOT have deleted the shared key (that would destroy
  // the winner's AssetVersion's underlying bytes).
  const expectedKey = `generated/${projectId}/${job.id}/${job.id}.mp4`;
  assert.ok(storageState.stored.has(expectedKey), "Winner's bytes must be in storage");
  assert.equal(storageState.stored.size, 1, "Only one storage entry must remain");
  assert.equal(
    storageState.deleteCalls.filter((k) => k === expectedKey).length,
    0,
    "The loser's storage key must NOT have been deleted (it is the winner's key)",
  );

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario M: DB persistence fails after storage.put succeeds — storage
//            cleanup runs, original error is propagated, cleanup failure
//            does not replace the original error.
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario M: DB failure after storage.put triggers cleanup and propagates the DB error", async () => {
  // The provider download succeeds normally.
  const mock = makeMockProviderWithDownload({});

  const { stores, storageState, teardown } = setupTest(mock);

  // Replace the registered DB with a failing-transaction variant.
  // This simulates a DB connection loss during the persistence
  // transaction while keeping everything else (pre-checks, storage,
  // download) working.
  const dbError = new Error("simulated DB connection lost during commit");
  const currentDb = getDb() as any;
  const failingDb: any = {
    select: currentDb.select,
    update: currentDb.update,
    insert: currentDb.insert,
    async transaction<T>(_cb: (tx: any) => Promise<T>): Promise<T> {
      throw dbError;
    },
  };
  setDb(failingDb);

  // Re-create the service so it picks up the new DB.
  const service = new GenerationResultService();

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  let caught: unknown;
  try {
    await service.persistResult(job.id as string, projectId);
  } catch (err) {
    caught = err;
  }

  // The original DB error must propagate, NOT a wrapped/cleanup error.
  assert.ok(caught, "persistResult must throw on DB failure");
  assert.strictEqual(caught, dbError, "The original DB error must be the thrown error");

  // The storage key must have been deleted as compensating cleanup.
  const expectedKey = `generated/${projectId}/${job.id}/${job.id}.mp4`;
  assert.ok(
    storageState.deleteCalls.includes(expectedKey),
    `storage.delete must have been called with the generated key "${expectedKey}"`,
  );
  assert.equal(
    storageState.stored.has(expectedKey),
    false,
    "Orphan storage object must be removed after DB failure",
  );

  // No AssetVersion was created and the job's assetVersionId stays null.
  assert.equal(stores.versions.size, 0, "No AssetVersion must be created on DB failure");
  assert.equal(stores.jobs.get(job.id as string)?.assetVersionId, null);

  teardown();
});

// ---------------------------------------------------------------------------
// Scenario N: DB failure + cleanup failure — original DB error still wins
// ---------------------------------------------------------------------------

test("GenerationResult - Scenario N: storage cleanup failure does not replace the original DB error", async () => {
  const mock = makeMockProviderWithDownload({});

  // Force the storage delete (cleanup) to fail.
  const { stores, storageState, teardown } = setupTest(mock, {
    deleteShouldFail: true,
    deleteFailMessage: "Disk went away during cleanup",
  });

  // Force the DB call to fail.
  const dbError = new Error("simulated DB deadlock");
  const currentDb = getDb() as any;
  const failingDb: any = {
    select: currentDb.select,
    update: currentDb.update,
    insert: currentDb.insert,
    async transaction<T>(_cb: (tx: any) => Promise<T>): Promise<T> {
      throw dbError;
    },
  };
  setDb(failingDb);
  const service = new GenerationResultService();

  const projectId = randomUUID();
  const provider = makeProvider();
  const asset = makeAsset(projectId);
  const job = makeJob({ projectId, providerId: provider.id, assetId: asset.id });

  stores.providers.set(provider.id, provider);
  stores.assets.set(asset.id as string, asset);
  stores.jobs.set(job.id as string, job);

  let caught: unknown;
  try {
    await service.persistResult(job.id as string, projectId);
  } catch (err) {
    caught = err;
  }

  // The ORIGINAL DB error must propagate, NOT the cleanup error.
  assert.ok(caught, "persistResult must throw");
  assert.strictEqual(caught, dbError, "Cleanup failure must not replace the original DB error");
  assert.doesNotMatch(
    String((caught as Error).message ?? ""),
    /Disk went away/,
    "Cleanup error message must not be the one surfaced to the caller",
  );

  // Cleanup WAS attempted (delete was called even though it threw).
  const expectedKey = `generated/${projectId}/${job.id}/${job.id}.mp4`;
  assert.ok(
    storageState.deleteCalls.includes(expectedKey),
    "Cleanup delete must have been attempted",
  );

  teardown();
});
