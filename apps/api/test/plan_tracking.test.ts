// ---------------------------------------------------------------------------
// C8.3 — Read-only execution tracking for plan-generated jobs
//
// GET /projects/:projectId/production-plans/:id/execution
//
// Covers: authorized owner retrieval, foreign project/plan ownership (404),
// only persisted generatedJobIds being considered, queued/active/completed/
// failed/cancelled representation, progress + sanitized errors, completed
// outputs exposed only through genuine job→asset-version→asset links,
// missing/malformed provenance handling, repeated GETs performing no writes
// (no new jobs, no plan payload/status changes, no provider or lifecycle
// calls), stable ordering, and partial results.
//
// All providers are deterministic in-process mocks — no real or paid AI
// call can ever happen (guarded by a global fetch tripwire).
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import { PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY } from "@icooro/shared";

const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name");

function tableNameOf(table: unknown): string {
  return (table as any)?.[DRIZZLE_TABLE_NAME] ?? "";
}

type Term = { column: string; value: unknown };

function walkPredicate(cond: unknown): Term[] {
  const out: Term[] = [];
  if (!cond || typeof cond !== "object") return out;
  const chunks: unknown[] = Array.isArray((cond as any).queryChunks) ? (cond as any).queryChunks : [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || typeof chunk !== "object") continue;
    if (Array.isArray((chunk as any).queryChunks)) {
      out.push(...walkPredicate(chunk));
      continue;
    }
    const name = (chunk as any).name;
    const columnName =
      typeof name === "string" ? name : name && typeof name.name === "string" ? name.name : null;
    if (!columnName) continue;
    const next = chunks[i + 1];
    const after = chunks[i + 2];
    if (next && typeof next === "object" && Array.isArray(next.value)) {
      const op = next.value.join("");
      if (op === " = ") {
        out.push({ column: columnName, value: after && "value" in after ? after.value : after });
        i += 2;
      } else if (op === " in ") {
        const values = chunks[i + 2];
        const unwrapped = Array.isArray(values)
          ? values.map((v: any) => (v && typeof v === "object" && "value" in v ? v.value : v))
          : [];
        out.push({ column: columnName, value: { __in: unwrapped } });
        i += 2;
      }
    }
  }
  return out;
}

function rowMatches(row: Record<string, unknown>, terms: Term[]): boolean {
  for (const t of terms) {
    const camel = t.column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const actual = t.column in row ? row[t.column] : row[camel];
    if (t.value && typeof t.value === "object" && "__in" in (t.value as any)) {
      const list = (t.value as any).__in as unknown[];
      if (!list.includes(actual)) return false;
      continue;
    }
    if (actual !== t.value) return false;
  }
  return true;
}

interface Stores {
  users: Map<string, Record<string, unknown>>;
  sessions: Map<string, Record<string, unknown>>;
  projects: Map<string, Record<string, unknown>>;
  episodes: Map<string, Record<string, unknown>>;
  scenes: Map<string, Record<string, unknown>>;
  shots: Map<string, Record<string, unknown>>;
  aiJobs: Map<string, Record<string, unknown>>;
  productionPlans: Map<string, Record<string, unknown>>;
  aiProviders: Map<string, Record<string, unknown>>;
  aiModels: Map<string, Record<string, unknown>>;
  assets: Map<string, Record<string, unknown>>;
  assetVersions: Map<string, Record<string, unknown>>;
}

function makeFakeDb(stores: Stores) {
  const fakeDb: any = {};
  function storeFor(table: unknown): Map<string, Record<string, unknown>> {
    const name = tableNameOf(table);
    if (name === "users") return stores.users;
    if (name === "sessions") return stores.sessions;
    if (name === "projects") return stores.projects;
    if (name === "episodes") return stores.episodes;
    if (name === "scenes") return stores.scenes;
    if (name === "shots") return stores.shots;
    if (name === "ai_jobs") return stores.aiJobs;
    if (name === "production_plans") return stores.productionPlans;
    if (name === "ai_providers") return stores.aiProviders;
    if (name === "ai_models") return stores.aiModels;
    if (name === "assets") return stores.assets;
    if (name === "asset_versions") return stores.assetVersions;
    throw new Error(`fake db: unknown table ${name}`);
  }

  function selectRows(table: unknown, cond: unknown): Array<Record<string, unknown>> {
    const store = storeFor(table);
    const all = Array.from(store.values()).map((r) => ({ ...r }));
    if (cond === undefined) return all;
    const terms = walkPredicate(cond);
    return all.filter((r) => rowMatches(r, terms));
  }

  let txChain: Promise<unknown> = Promise.resolve();

  Object.assign(fakeDb, {
    select(_projection?: Record<string, unknown>) {
      const from = (table: unknown) => {
        const base = {
          rows: [] as Array<Record<string, unknown>>,
          cond: undefined as unknown,
        };
        const builder: any = {
          innerJoin(_joined: unknown, _on: unknown) {
            return builder;
          },
          leftJoin(_joined: unknown, _on: unknown) {
            return builder;
          },
          where(cond: unknown) {
            base.cond = cond;
            base.rows = selectRows(table, cond);
            return {
              async for(_mode: string) {
                base.rows = selectRows(table, base.cond);
                return base.rows;
              },
              then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
                return Promise.resolve(base.rows).then(resolve, reject);
              },
            };
          },
          orderBy() {
            return Promise.resolve(base.rows);
          },
          limit() {
            return Promise.resolve(base.rows);
          },
          then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
            base.rows = selectRows(table, base.cond);
            return Promise.resolve(base.rows).then(resolve, reject);
          },
        };
        return builder;
      };
      return { from };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown>) {
          const store = storeFor(table);
          const newId = (vals.id as string) ?? randomUUID();
          const now = new Date();
          const defaulted: Record<string, unknown> = { id: newId, ...vals };
          if (defaulted.createdAt === undefined) defaulted.createdAt = now;
          if (defaulted.updatedAt === undefined) defaulted.updatedAt = now;
          for (const key of Object.keys(defaulted)) {
            if (defaulted[key] === undefined) defaulted[key] = null;
          }
          store.set(newId, defaulted);
          return { $returningId: () => Promise.resolve([{ id: newId }]) };
        },
      };
    },
    update(table: unknown) {
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              const terms = walkPredicate(cond);
              const store = storeFor(table);
              let affected = 0;
              for (const row of store.values()) {
                if (rowMatches(row, terms)) {
                  Object.assign(row, vals);
                  affected += 1;
                }
              }
              return Promise.resolve({ affectedRows: affected });
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(cond: unknown) {
          const terms = walkPredicate(cond);
          const store = storeFor(table);
          for (const [key, row] of Array.from(store.entries())) {
            if (rowMatches(row, terms)) store.delete(key);
          }
          return Promise.resolve({ affectedRows: 1 });
        },
      };
    },
    transaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => cb(fakeDb);
      const next = txChain.then(run, run);
      txChain = next.catch(() => undefined);
      return next;
    },
    __stores: stores,
  });

  return fakeDb;
}

function setupDb(): Stores {
  const stores: Stores = {
    users: new Map(),
    sessions: new Map(),
    projects: new Map(),
    episodes: new Map(),
    scenes: new Map(),
    shots: new Map(),
    aiJobs: new Map(),
    productionPlans: new Map(),
    aiProviders: new Map(),
    aiModels: new Map(),
    assets: new Map(),
    assetVersions: new Map(),
  };
  setDb(makeFakeDb(stores));
  return stores;
}

function teardownDb() {
  setDb(null as any);
}

// --- HTTP helpers ----------------------------------------------------------

async function jsonRequest(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const isBodyless = init.method === undefined || init.method === "GET" || init.method === "HEAD";
  const req = new Request(`http://localhost${path}`, {
    ...init,
    headers,
    ...(isBodyless ? { body: undefined } : {}),
  });
  return app.fetch(req);
}

function readSetCookie(res: Response): { name: string; value: string } | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const first = raw.split(";")[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq === -1) return null;
  return { name: first.slice(0, eq), value: first.slice(eq + 1) };
}

async function userSession(stores: Stores, email = "user@example.com") {
  const res = await jsonRequest("/api/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "longenoughpassword", name: "User" }),
  });
  assert.equal(res.status, 201);
  const cookie = readSetCookie(res)!;
  return `${cookie.name}=${cookie.value}`;
}

async function seedProject(stores: Stores, cookie: string, name = "C8.3 Project"): Promise<string> {
  const res = await jsonRequest("/api/v1/projects", {
    method: "POST",
    cookie,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { data: any }).data.id;
}

function seedEpisode(stores: Stores, projectId: string): string {
  const id = randomUUID();
  stores.episodes.set(id, {
    id,
    projectId,
    title: "Episode 1",
    episodeNumber: 1,
    status: "draft",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedScene(stores: Stores, episodeId: string, orderIndex: number): string {
  const id = randomUUID();
  stores.scenes.set(id, {
    id,
    episodeId,
    name: `Scene ${orderIndex}`,
    description: `Scene ${orderIndex}`,
    orderIndex,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedShot(stores: Stores, sceneId: string, orderIndex: number): string {
  const id = randomUUID();
  stores.shots.set(id, {
    id,
    sceneId,
    orderIndex,
    purpose: "Establish",
    shotType: "wide",
    framing: "full shot",
    cameraMovement: "static",
    cameraAngle: "eye level",
    prompt: "A wide shot of a small cartoon town.",
    visualDescription: "A town.",
    actionDescription: "Mozy looks out.",
    dialogue: null,
    transition: "cut",
    productionNotes: null,
    duration: 8,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedAsset(
  stores: Stores,
  ctx: { projectId: string },
  overrides: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  stores.assets.set(id, {
    id,
    projectId: ctx.projectId,
    name: "Generated shot asset",
    description: null,
    status: "ready",
    type: "video",
    approvedVersionId: null,
    episodeId: null,
    sceneId: null,
    shotId: null,
    characterId: null,
    locationId: null,
    propId: null,
    storageKey: null,
    mimeType: null,
    fileSize: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

function seedAssetVersion(
  stores: Stores,
  ctx: { assetId: string; version: number },
  overrides: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  stores.assetVersions.set(id, {
    id,
    assetId: ctx.assetId,
    version: ctx.version,
    status: "ready",
    sourceKind: "generated",
    storageKey: `generated/p_1/${id}.mp4`,
    fileExtension: "mp4",
    mimeType: "video/mp4",
    fileSize: 123456,
    checksum: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

type SeedJobOverrides = Partial<{
  status: string;
  jobType: string;
  projectId: string;
  sceneId: string;
  shotId: string | null;
  episodeId: string;
  progress: number | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  assetId: string | null;
  assetVersionId: string | null;
  updatedAt: Date;
}>;

/**
 * Seeds a plan-generated ai_jobs row in the C8.1 shape, carrying the plan
 * provenance in metadata (provider/model binding is irrelevant here — the
 * tracking endpoint never resolves adapters).
 */
function seedPlanJob(
  stores: Stores,
  planId: string,
  ctx: { projectId: string; episodeId: string; sceneId: string; shotId: string | null },
  overrides: SeedJobOverrides = {},
): string {
  const id = randomUUID();
  stores.aiJobs.set(id, {
    id,
    jobType: "text-to-video",
    status: "queued",
    providerId: null,
    modelId: null,
    externalJobId: null,
    projectId: ctx.projectId,
    episodeId: ctx.episodeId,
    sceneId: ctx.sceneId,
    shotId: ctx.shotId,
    shotVersionId: null,
    assetId: null,
    assetVersionId: null,
    prompt: "A wide shot of a small cartoon town.",
    negativePrompt: null,
    targetMediaType: "video",
    requestedDuration: null,
    requestedWidth: null,
    requestedHeight: null,
    progress: 0,
    error: null,
    metadata: { productionPlanId: planId, source: "production-plan" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

function seedPlanWithJobs(
  stores: Stores,
  projectId: string,
  episodeId: string | null,
  jobIds: string[],
  overrides: Record<string, unknown> = {},
  /** The plan's authoritative tracked-scene set (C7.4 `sceneIds`). */
  sceneIds: string[] = [],
): string {
  const id = randomUUID();
  stores.productionPlans.set(id, {
    id,
    projectId,
    episodeId,
    request: "Make a 30-second Mozytoon episode about colors",
    status: "approved",
    plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: jobIds, sceneIds },
    targetDurationSeconds: 30,
    preferences: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

/** Re-links an existing job to a completed asset version (persist-result shape). */
function linkJobOutput(
  stores: Stores,
  jobId: string,
  assetId: string,
  assetVersionId: string,
): void {
  stores.aiJobs.set(jobId, {
    ...stores.aiJobs.get(jobId)!,
    assetId,
    assetVersionId,
  });
}

async function track(
  projectId: string,
  planId: string,
  cookie: string,
): Promise<{ status: number; body: { data?: any; error?: any } }> {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/execution`,
    { method: "GET", cookie },
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

function withFetchTripwire<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("TRIPWIRE: external network call attempted during plan tracking");
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

// ---------------------------------------------------------------------------
// 1. Authorized owner can retrieve current execution tracking
// ---------------------------------------------------------------------------

test("C8.3 Tracking - owner reads current state for every lifecycle status", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);
    const shotC = seedShot(stores, sceneId, 3);
    const shotD = seedShot(stores, sceneId, 4);
    const shotE = seedShot(stores, sceneId, 5);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const queuedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA });
    const processingJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotB }, {
      status: "processing",
      progress: 40,
      externalJobId: "ext-1",
    });
    const completedAssetId = seedAsset(stores, { projectId });
    const completedVersionId = seedAssetVersion(stores, { assetId: completedAssetId, version: 1 });
    const completedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotC }, {
      status: "completed",
      progress: 100,
    });
    linkJobOutput(stores, completedJob, completedAssetId, completedVersionId);
    const failedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotD }, {
      status: "failed",
      error: "ProviderError: upstream exploded apiKey=[redacted] [url]",
    });
    const cancelledJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotE }, {
      status: "cancelled",
    });
    const tracked = [queuedJob, processingJob, completedJob, failedJob, cancelledJob];
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: tracked, sceneIds: [sceneId] },
    });

    const res = await withFetchTripwire(() => track(projectId, planId, cookie));
    assert.equal(res.status, 200);

    const report = res.body.data!;
    assert.equal(report.productionPlanId, planId);
    assert.equal(report.jobType, "text-to-video");
    assert.equal(report.status, "active", "one job is still processing");
    assert.equal(report.counts.total, 5);
    assert.equal(report.counts.active, 2);
    assert.equal(report.counts.completed, 1);
    assert.equal(report.counts.failed, 1);
    assert.equal(report.counts.cancelled, 1);
    assert.equal(report.counts.missing, 0);
    assert.equal(report.counts.invalid, 0);

    // Stable, deterministic ordering: records follow generatedJobIds order.
    assert.deepEqual(report.records.map((r: any) => r.jobId), tracked);

    const byId = new Map(report.records.map((r: any) => [r.jobId, r]));
    assert.equal(byId.get(queuedJob).recordState, "active");
    assert.equal(byId.get(queuedJob).status, "queued");
    assert.equal(byId.get(processingJob).status, "processing");
    assert.equal(byId.get(processingJob).progress, 40);
    assert.equal(byId.get(completedJob).recordState, "terminal");
    assert.equal(byId.get(completedJob).status, "completed");
    assert.equal(byId.get(failedJob).recordState, "terminal");
    assert.equal(byId.get(failedJob).status, "failed");
    assert.equal(
      byId.get(failedJob).error,
      "ProviderError: upstream exploded apiKey=[redacted] [url]",
    );
    assert.equal(byId.get(cancelledJob).recordState, "terminal");
    assert.equal(byId.get(cancelledJob).status, "cancelled");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Ownership
// ---------------------------------------------------------------------------

test("C8.3 Tracking - foreign project and wrong-project plan are invisible", async () => {
  const stores = setupDb();
  try {
    const ownerCookie = await userSession(stores, "owner@example.com");
    const projectId = await seedProject(stores, ownerCookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const jobId = seedPlanJob(stores, "plan-x", { projectId, episodeId, sceneId, shotId });
    const planId = seedPlanWithJobs(stores, projectId, episodeId, [jobId], {}, [sceneId]);

    const intruder = await userSession(stores, "intruder@example.com");
    const foreignProject = await track(projectId, planId, intruder);
    assert.equal(foreignProject.status, 404);
    assert.equal(foreignProject.body.error!.message, "Project not found");

    const projectB = await seedProject(stores, ownerCookie, "B");
    const wrongProject = await track(projectB, planId, ownerCookie);
    assert.equal(wrongProject.status, 404);
    assert.equal(wrongProject.body.error!.message, "Production plan not found");

    const missing = await track(projectId, randomUUID(), ownerCookie);
    assert.equal(missing.status, 404);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Only persisted generatedJobIds are considered
// ---------------------------------------------------------------------------

test("C8.3 Tracking - untracked jobs are never reported, payload list is the only source", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const trackedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA });
    const untrackedJob = seedPlanJob(stores, planId, {
      projectId,
      episodeId,
      sceneId,
      shotId: shotB,
    });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [trackedJob], sceneIds: [sceneId] },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].jobId, trackedJob);
    assert.ok(!JSON.stringify(report).includes(untrackedJob));
  } finally {
    teardownDb();
  }
});

test("C8.3 Tracking - empty and malformed provenance report empty, not errors", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);

    // Empty list.
    const emptyPlan = seedPlanWithJobs(stores, projectId, episodeId, []);
    const emptyRes = await track(projectId, emptyPlan, cookie);
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.body.data!.status, "empty");
    assert.deepEqual(emptyRes.body.data!.records, []);

    // Malformed provenance: wrong types / garbage entries — C8.1's
    // extraction filters out everything that is not a non-empty string,
    // exactly like C8.2's execution path. (A whitespace-only string
    // survives that established filter and therefore reports as a
    // missing job — the same treatment C8.2 gives an unresolvable id.)
    const garbagePlan = seedPlanWithJobs(stores, projectId, episodeId, []);
    stores.productionPlans.set(garbagePlan, {
      ...stores.productionPlans.get(garbagePlan)!,
      plan: {
        [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: ["", 42, null, { nope: true }, "   "],
      },
    });
    const garbageRes = await track(projectId, garbagePlan, cookie);
    assert.equal(garbageRes.status, 200);
    const garbageReport = garbageRes.body.data!;
    assert.equal(garbageReport.counts.total, 1, "only the non-empty string survives extraction");
    assert.equal(garbageReport.records[0].jobId, "   ");
    assert.equal(garbageReport.records[0].recordState, "missing");
    // No real work exists behind the malformed entry, so the aggregate
    // carries no active/terminal outcome — the record-level reason says why.
    assert.equal(garbageReport.status, "empty");
    assert.equal(garbageReport.counts.missing, 1);

    // Null payload entirely.
    const nullPlan = seedPlanWithJobs(stores, projectId, episodeId, [], { plan: null });
    const nullRes = await track(projectId, nullPlan, cookie);
    assert.equal(nullRes.status, 200);
    assert.equal(nullRes.body.data!.status, "empty");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Progress and sanitized errors
// ---------------------------------------------------------------------------

test("C8.3 Tracking - progress is returned when present and error is the sanitized persisted one", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const downloadingJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA }, {
      status: "downloading",
      progress: 80,
    });
    const failedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotB }, {
      status: "failed",
      error: "ProviderError: upstream exploded apiKey=[redacted] [url]",
    });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: {
        [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [downloadingJob, failedJob],
        sceneIds: [sceneId],
      },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    const byId = new Map(report.records.map((r: any) => [r.jobId, r]));
    assert.equal(byId.get(downloadingJob).progress, 80);
    assert.equal(byId.get(failedJob).progress, 0);
    assert.equal(
      byId.get(failedJob).error,
      "ProviderError: upstream exploded apiKey=[redacted] [url]",
    );
    // No error text on non-failed records.
    assert.equal(byId.get(downloadingJob).error, null);
    // Failed records never expose their shot/scene of failure context? They do —
    // but missing/invalid records must not (covered below).
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Completed outputs: only genuine persisted links
// ---------------------------------------------------------------------------

test("C8.3 Tracking - completed job exposes its real asset/version output", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId }, {
      status: "completed",
      progress: 100,
    });
    const assetId = seedAsset(stores, { projectId }, { name: "Mozy shot 1" });
    const versionId = seedAssetVersion(stores, { assetId, version: 2 });
    linkJobOutput(stores, jobId, assetId, versionId);
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [jobId], sceneIds: [sceneId] },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "completed");
    const record = report.records[0];
    assert.ok(record.output, "the linked output must be exposed");
    assert.equal(record.output.assetVersionId, versionId);
    assert.equal(record.output.assetId, assetId);
    assert.equal(record.output.assetName, "Mozy shot 1");
    assert.equal(record.output.version, 2);
    assert.equal(record.output.mimeType, "video/mp4");
    assert.equal(record.output.fileSize, 123456);
  } finally {
    teardownDb();
  }
});

test("C8.3 Tracking - completed status alone never fabricates an output", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId }, {
      status: "completed",
      progress: 100,
    });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [jobId], sceneIds: [sceneId] },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const record = res.body.data!.records[0];
    assert.equal(record.status, "completed");
    assert.equal(record.output, null, "no link persisted means no output reported");
  } finally {
    teardownDb();
  }
});

test("C8.3 Tracking - broken or cross-project output links are not exposed", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    // Dangling version link: the job points at a version row that is gone.
    const danglingJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA }, {
      status: "completed",
    });
    linkJobOutput(stores, danglingJob, seedAsset(stores, { projectId }), randomUUID());
    // Cross-project link: version+asset exist but belong to another project.
    const crossJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotB }, {
      status: "completed",
    });
    const foreignProjectId = "proj-foreign";
    const foreignAssetId = seedAsset(stores, { projectId: foreignProjectId });
    const foreignVersionId = seedAssetVersion(stores, { assetId: foreignAssetId, version: 1 });
    linkJobOutput(stores, crossJob, foreignAssetId, foreignVersionId);
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: {
        [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [danglingJob, crossJob],
        sceneIds: [sceneId],
      },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const byId = new Map(res.body.data!.records.map((r: any) => [r.jobId, r]));
    assert.equal(byId.get(danglingJob).output, null);
    assert.equal(byId.get(crossJob).output, null);
    // No foreign identifiers leak.
    const json = JSON.stringify(res.body);
    assert.ok(!json.includes(foreignProjectId));
    assert.ok(!json.includes(foreignAssetId));
    assert.ok(!json.includes(foreignVersionId));
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Missing and invalid records
// ---------------------------------------------------------------------------

test("C8.3 Tracking - missing jobs and context-invalid jobs are reported safely", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const projectB = await seedProject(stores, cookie, "B");
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const foreignProjectJob = seedPlanJob(stores, planId, {
      projectId: projectB,
      episodeId,
      sceneId,
      shotId,
    });
    const wrongPlanJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    stores.aiJobs.set(wrongPlanJob, {
      ...stores.aiJobs.get(wrongPlanJob)!,
      metadata: { productionPlanId: randomUUID(), source: "production-plan" },
    });
    const manualJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    stores.aiJobs.set(manualJob, {
      ...stores.aiJobs.get(manualJob)!,
      metadata: null, // manual C6 job — never attributed to this plan
    });
    const wrongTypeJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    stores.aiJobs.set(wrongTypeJob, {
      ...stores.aiJobs.get(wrongTypeJob)!,
      jobType: "text-to-image",
    });
    const missingId = randomUUID();
    const tracked = [foreignProjectJob, wrongPlanJob, manualJob, wrongTypeJob, missingId];
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: tracked, sceneIds: [sceneId] },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.counts.invalid, 4);
    assert.equal(report.counts.missing, 1);
    assert.equal(report.status, "empty", "no active/terminal work is present");

    // Stable ordering preserved despite missing/invalid rows.
    assert.deepEqual(report.records.map((r: any) => r.jobId), tracked);

    const byId = new Map(report.records.map((r: any) => [r.jobId, r]));
    for (const jobId of [foreignProjectJob, wrongPlanJob, manualJob, wrongTypeJob]) {
      assert.equal(byId.get(jobId).recordState, "invalid");
      assert.match(byId.get(jobId).reason, /no longer belongs to this production plan's context/);
      // Mismatched rows never expose their shot/scene context.
      assert.equal(byId.get(jobId).shotId, null);
      assert.equal(byId.get(jobId).sceneId, null);
      assert.equal(byId.get(jobId).output, null);
    }
    // The lifecycle status is still reported for invalid rows (C8.2
    // context-skip convention), but nothing more of the row.
    assert.equal(byId.get(manualJob).status, "queued");

    const missingRecord = byId.get(missingId);
    assert.equal(missingRecord.recordState, "missing");
    assert.match(missingRecord.reason, /no longer exists/);
    assert.equal(missingRecord.status, null);
    assert.equal(missingRecord.progress, null);

    // The report never reveals other projects' identifiers.
    const json = JSON.stringify(report);
    assert.ok(!json.includes(projectB));
  } finally {
    teardownDb();
  }
});

test("C8.3 Tracking - unknown status values are bucketed as invalid, not guessed", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const weirdJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId }, {
      status: "weird_status",
    });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [weirdJob], sceneIds: [sceneId] },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const record = res.body.data!.records[0];
    assert.equal(record.recordState, "invalid");
    assert.match(record.reason, /unsupported status/);
    assert.equal(record.status, null);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7. Partial results with stable ordering
// ---------------------------------------------------------------------------

test("C8.3 Tracking - stable ordering and partial results when one job is missing", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const firstJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA }, {
      status: "processing",
      progress: 25,
    });
    const secondJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotB }, {
      status: "completed",
      progress: 100,
    });
    const assetId = seedAsset(stores, { projectId });
    const versionId = seedAssetVersion(stores, { assetId, version: 1 });
    linkJobOutput(stores, secondJob, assetId, versionId);
    const missingId = randomUUID();
    const tracked = [firstJob, missingId, secondJob];
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: tracked, sceneIds: [sceneId] },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await track(projectId, planId, cookie);
      assert.equal(res.status, 200);
      const report = res.body.data!;
      assert.equal(report.status, "active");
      assert.equal(report.counts.active, 1);
      assert.equal(report.counts.completed, 1);
      assert.equal(report.counts.missing, 1);
      // Identical order on every GET.
      assert.deepEqual(report.records.map((r: any) => r.jobId), tracked);
      assert.equal(report.records[0].status, "processing");
      assert.equal(report.records[1].recordState, "missing");
      assert.equal(report.records[2].output!.assetVersionId, versionId);
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8. Read-only guarantees
// ---------------------------------------------------------------------------

test("C8.3 Tracking - repeated GETs write nothing anywhere and never contact providers", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [jobId], sceneIds: [sceneId] },
    });

    const planBefore = JSON.stringify(stores.productionPlans.get(planId));
    const jobBefore = JSON.stringify(stores.aiJobs.get(jobId));
    const planCountBefore = stores.productionPlans.size;
    const jobCountBefore = stores.aiJobs.size;
    const assetCountBefore = stores.assets.size;
    const versionCountBefore = stores.assetVersions.size;

    const first = await withFetchTripwire(() => track(projectId, planId, cookie));
    const second = await withFetchTripwire(() => track(projectId, planId, cookie));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    // No new jobs, plans, assets or versions were created.
    assert.equal(stores.aiJobs.size, jobCountBefore);
    assert.equal(stores.productionPlans.size, planCountBefore);
    assert.equal(stores.assets.size, assetCountBefore);
    assert.equal(stores.assetVersions.size, versionCountBefore);

    // No plan payload/status write, no job-row write at all.
    assert.equal(JSON.stringify(stores.productionPlans.get(planId)), planBefore);
    assert.equal(JSON.stringify(stores.aiJobs.get(jobId)), jobBefore);
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued", "job row untouched");

    // Identical, stable reports across reads.
    assert.equal(JSON.stringify(first.body.data), JSON.stringify(second.body.data));
  } finally {
    teardownDb();
  }
});

test("C8.3 Tracking - unauthenticated requests are rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, []);

    const res = await track(projectId, planId, "nosession=none");
    assert.equal(res.status, 401);
    void cookie;
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 9. C8.3 hardening regressions — hierarchy validation, sceneIds
//    membership, completed-only output gating, and admin access.
// ---------------------------------------------------------------------------

test("C8.3 Hardening - a broken shot→scene→episode→project chain withholds context and output (fail closed)", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const projectB = await seedProject(stores, cookie, "Chain Project B");
    const episodeA = seedEpisode(stores, projectId);
    const foreignEpisode = seedEpisode(stores, projectB);
    const sceneId = seedScene(stores, episodeA, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeA, [], {}, [sceneId]);

    // 1. Shot deleted since tracking started.
    const deletedShotJob = seedPlanJob(stores, planId, {
      projectId,
      episodeId: episodeA,
      sceneId,
      shotId,
    });
    stores.shots.delete(shotId);

    // 2. The job's shot belongs to a DIFFERENT scene than the job records.
    const movedScene = seedScene(stores, episodeA, 2);
    const movedShot = seedShot(stores, movedScene, 1);
    const movedShotJob = seedPlanJob(stores, planId, {
      projectId,
      episodeId: episodeA,
      sceneId,
      shotId: movedShot,
    });

    // 3. The job's recorded scene is NOT in the plan's anchored episode.
    const foreignSceneEpisode = seedEpisode(stores, projectB);
    const foreignSceneJobScene = seedScene(stores, foreignSceneEpisode, 1);
    const foreignSceneShot = seedShot(stores, foreignSceneJobScene, 1);
    const foreignSceneJob = seedPlanJob(stores, planId, {
      projectId,
      episodeId: episodeA,
      sceneId: foreignSceneJobScene,
      shotId: foreignSceneShot,
    });

    // 4. The scene chain is fine, but the plan's ANCHOR episode was
    //    replaced with one from another project (episodeId in the row).
    const repointedPlan = seedPlanWithJobs(stores, projectId, foreignEpisode, [], {}, [sceneId]);
    const repointShot = seedShot(stores, sceneId, 8);
    const repointJob = seedPlanJob(stores, repointedPlan, {
      projectId,
      episodeId: foreignEpisode,
      sceneId,
      shotId: repointShot,
    });
    stores.productionPlans.set(repointedPlan, {
      ...stores.productionPlans.get(repointedPlan)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [repointJob], sceneIds: [sceneId] },
    });

    // 5. A healthy control job in the same plan proves the failures are
    //    per-record, not aggregate.
    const healthyShot = seedShot(stores, sceneId, 9);
    const healthyJob = seedPlanJob(stores, planId, {
      projectId,
      episodeId: episodeA,
      sceneId,
      shotId: healthyShot,
    });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: {
        [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [
          deletedShotJob,
          movedShotJob,
          foreignSceneJob,
          healthyJob,
        ],
        sceneIds: [sceneId],
      },
    });

    const res = await withFetchTripwire(() => track(projectId, planId, cookie));
    assert.equal(res.status, 200);
    const report = res.body.data!;
    const byId = new Map(report.records.map((r: any) => [r.jobId, r]));

    assert.equal(byId.get(healthyJob).recordState, "active");
    assert.equal(byId.get(healthyJob).shotId, healthyShot);
    assert.equal(byId.get(healthyJob).sceneId, sceneId);

    assert.equal(byId.get(deletedShotJob).recordState, "invalid");
    assert.match(byId.get(deletedShotJob).reason, /shot no longer exists/);
    assert.equal(byId.get(movedShotJob).recordState, "invalid");
    assert.match(byId.get(movedShotJob).reason, /shot no longer belongs to its recorded scene/);
    assert.equal(byId.get(foreignSceneJob).recordState, "invalid");
    assert.match(
      byId.get(foreignSceneJob).reason,
      /scene no longer belongs to the production plan's episode and project/,
    );
    for (const jobId of [deletedShotJob, movedShotJob, foreignSceneJob]) {
      assert.equal(byId.get(jobId).shotId, null, "no shot context leaks from a broken chain");
      assert.equal(byId.get(jobId).sceneId, null, "no scene context leaks from a broken chain");
      assert.equal(byId.get(jobId).output, null);
    }

    // A separate plan whose ANCHOR episode was replaced with one from
    // another project fails the same episode-in-project check — same
    // reason, still without leaking the foreign episode id.
    const repointRes = await withFetchTripwire(() => track(projectId, repointedPlan, cookie));
    assert.equal(repointRes.status, 200);
    const repointRecord = repointRes.body.data!.records[0];
    assert.equal(repointRecord.recordState, "invalid");
    assert.match(
      repointRecord.reason,
      /scene no longer belongs to the production plan's episode and project/,
    );
    assert.equal(repointRecord.shotId, null);
    assert.equal(repointRecord.sceneId, null);
    const repointJson = JSON.stringify(repointRes.body);
    assert.ok(!repointJson.includes(foreignEpisode));

    // No foreign-project identifiers leak into the report.
    const json = JSON.stringify(report);
    assert.ok(!json.includes(projectB));
    assert.ok(!json.includes(foreignSceneEpisode));
    assert.ok(!json.includes(foreignSceneJobScene));

    // Aggregate: only the healthy job contributes "active". (The repoint
    // case lives in its own plan, verified separately above.)
    assert.equal(report.counts.invalid, 3);
    assert.equal(report.counts.active, 1);
    assert.equal(report.status, "active");
  } finally {
    teardownDb();
  }
}
);

test(
  "C8.3 Hardening - a job whose recorded episodeId disagrees with its valid chain fails closed",
  async () => {
    const stores = setupDb();
    try {
      const cookie = await userSession(stores);
      const projectId = await seedProject(stores, cookie);
      const projectB = await seedProject(stores, cookie, "Episode Drift Project B");
      const episodeA = seedEpisode(stores, projectId);
      const wrongEpisode = seedEpisode(stores, projectId);
      const foreignEpisode = seedEpisode(stores, projectB);
      const sceneId = seedScene(stores, episodeA, 1);
      const shotId = seedShot(stores, sceneId, 1);

      const planId = seedPlanWithJobs(stores, projectId, episodeA, [], {}, [sceneId]);

      // The shot→scene→episode→project chain is entirely valid — but the
      // job row's OWN episodeId records a different episode of the SAME
      // project. Nothing else about the row is malformed.
      const driftedJob = seedPlanJob(stores, planId, {
        projectId,
        episodeId: wrongEpisode,
        sceneId,
        shotId,
      });

      // Malformed variant: a null episodeId on an otherwise identical row.
      const nullEpisodeJob = seedPlanJob(stores, planId, {
        projectId,
        episodeId: null as unknown as string,
        sceneId,
        shotId,
      });

      // Foreign variant: an episodeId belonging to another project.
      const foreignEpisodeJob = seedPlanJob(stores, planId, {
        projectId,
        episodeId: foreignEpisode,
        sceneId,
        shotId,
      });

      // Healthy control: identical shape with the correct episodeId.
      const healthyJob = seedPlanJob(stores, planId, {
        projectId,
        episodeId: episodeA,
        sceneId,
        shotId,
      });

      stores.productionPlans.set(planId, {
        ...stores.productionPlans.get(planId)!,
        plan: {
          [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [
            driftedJob,
            nullEpisodeJob,
            foreignEpisodeJob,
            healthyJob,
          ],
          sceneIds: [sceneId],
        },
      });

      const res = await withFetchTripwire(() => track(projectId, planId, cookie));
      assert.equal(res.status, 200);
      const report = res.body.data!;
      const byId = new Map(report.records.map((r: any) => [r.jobId, r]));

      for (const jobId of [driftedJob, nullEpisodeJob, foreignEpisodeJob]) {
        const record = byId.get(jobId);
        assert.equal(record.recordState, "invalid");
        assert.match(
          record.reason,
          /recorded episode no longer matches the production plan's episode/,
        );
        assert.equal(record.shotId, null, "no shot context from an episode-drifted row");
        assert.equal(record.sceneId, null, "no scene context from an episode-drifted row");
        assert.equal(record.output, null);
        assert.equal(record.status, "queued", "lifecycle status reported per the C8.2 convention");
      }

      assert.equal(byId.get(healthyJob).recordState, "active");
      assert.equal(byId.get(healthyJob).sceneId, sceneId);
      assert.equal(byId.get(healthyJob).shotId, shotId);

      // Aggregate: only the healthy job counts as active work.
      assert.equal(report.counts.invalid, 3);
      assert.equal(report.counts.active, 1);
      assert.equal(report.status, "active");

      // No foreign identifiers leak through the report.
      const json = JSON.stringify(report);
      assert.ok(!json.includes(projectB));
      assert.ok(!json.includes(foreignEpisode));
    } finally {
      teardownDb();
    }
  },
);

test("C8.3 Hardening - a scene outside the plan's authoritative sceneIds fails closed", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const trackedScene = seedScene(stores, episodeId, 1);
    const untrackedScene = seedScene(stores, episodeId, 2);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [trackedScene]);
    const shotInUntracked = seedShot(stores, untrackedScene, 1);
    const untrackedJob = seedPlanJob(stores, planId, {
      projectId,
      episodeId,
      sceneId: untrackedScene,
      shotId: shotInUntracked,
    });
    // The plan's payload at THIS point carries the wrong (narrower) scene
    // set than the real rows, proving authoritative `sceneIds` — not the
    // rows on disk — is the source of truth, and that divergence is
    // reported rather than waved through.
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [untrackedJob], sceneIds: [trackedScene] },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const record = res.body.data!.records[0];
    assert.equal(record.recordState, "invalid");
    assert.match(record.reason, /scene is not tracked by this production plan/);
    assert.equal(record.shotId, null);
    assert.equal(record.sceneId, null);
    assert.equal(record.status, "queued", "lifecycle status reported per the C8.2 skip convention");
    assert.equal(record.output, null);
    assert.equal(res.body.data!.counts.invalid, 1);
    assert.equal(res.body.data!.status, "empty");
  } finally {
    teardownDb();
  }
});

test("C8.3 Hardening - a plan payload without sceneIds can never prove membership", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, []);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [jobId] },
    });

    const res = await track(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const record = res.body.data!.records[0];
    assert.equal(record.recordState, "invalid");
    assert.match(
      record.reason,
      /payload does not record the tracked scene set this job must belong to/,
    );
    assert.equal(record.shotId, null);
    assert.equal(record.sceneId, null);
  } finally {
    teardownDb();
  }
});

test("C8.3 Hardening - an active job with populated asset references exposes NO output link", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const activeJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId }, {
      status: "processing",
      progress: 50,
    });
    // Asset references populated even though the job is still active —
    // e.g. a stale or corrupted row that survived a re-queue. Output is
    // gated on ACTUAL completion plus persistence checks, never on refs
    // alone and never inferred from progress.
    const assetId = seedAsset(stores, { projectId });
    const versionId = seedAssetVersion(stores, { assetId, version: 1 });
    linkJobOutput(stores, activeJob, assetId, versionId);
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [activeJob], sceneIds: [sceneId] },
    });

    const res = await withFetchTripwire(() => track(projectId, planId, cookie));
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "active");
    const record = report.records[0];
    assert.equal(record.recordState, "active");
    assert.equal(record.status, "processing");
    assert.equal(record.output, null, "active job must not expose an output link");
    assert.equal(record.shotId, shotId, "healthy context is still reported for a valid active job");
    assert.equal(record.sceneId, sceneId);
  } finally {
    teardownDb();
  }
});

test("C8.3 Hardening - missing user identity is rejected even with a stale role hint", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });

    // Session middleware without a resolvable user sets userId=null and
    // userRole=null. The route's `?? "user"` default would make that
    // look like a plain (non-admin) caller whose empty id would SKIP
    // the ownership comparison — the degenerate case the hardened route
    // closes by 401ing before any project probe.
    const res = await jsonRequest(
      `/api/v1/projects/${projectId}/production-plans/${planId}/execution`,
      { method: "GET", cookie: "nosession=none" },
    );
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(res.status, 401);
    assert.equal(body.error!.code, "UNAUTHORIZED");
  } finally {
    teardownDb();
  }
});

test("C8.3 Hardening - an authenticated ADMIN can still read tracking for any project", async () => {
  const stores = setupDb();
  try {
    const ownerCookie = await userSession(stores, "owner@example.com");
    const projectId = await seedProject(stores, ownerCookie);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedPlanWithJobs(stores, projectId, episodeId, [], {}, [sceneId]);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    stores.productionPlans.set(planId, {
      ...stores.productionPlans.get(planId)!,
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: [jobId], sceneIds: [sceneId] },
    });

    // Admin: signup a second account, then promote its row directly
    // (same approach as admin.test.ts). The session cookie predates the
    // promotion but resolves the user row on every request, so the
    // role change applies to the NEXT request.
    const adminCookie = await userSession(stores, "admin@example.com");
    for (const u of stores.users.values()) {
      if (u.email === "admin@example.com") u.role = "admin";
    }

    const res = await track(projectId, planId, adminCookie);
    assert.equal(res.status, 200, "admin ownership bypass preserved");
    const report = res.body.data!;
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].jobId, jobId);
    assert.equal(report.records[0].recordState, "active");
  } finally {
    teardownDb();
  }
});
