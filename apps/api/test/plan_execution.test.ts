// ---------------------------------------------------------------------------
// C8.2 — Execution initiation for plan-generated jobs
//
// POST /projects/:projectId/production-plans/:id/execute
//
// Covers: successful initiation of queued plan jobs, multiple jobs, plan
// approval gate, project/plan ownership, missing tracked job ids, jobs
// whose context no longer matches the plan, already-active and terminal
// jobs, unsupported job type / provider-model configuration failures,
// provider submission failure, partial success, repeated requests, and
// proof that NO new ai_jobs rows are created and NO provider call happens
// outside the existing executor path.
//
// All providers are deterministic in-process mocks — no real or paid AI
// call can ever happen (guarded by a global fetch tripwire).
//
// CONCURRENCY NOTE: the fake DB serializes transactions, which lets these
// tests assert request-level ordering but is NOT proof of real MySQL
// locking behavior. The duplicate-submission guarantee under test here is
// the existing executor's queued-status check plus its in-process
// submissionsInFlight guard — the same guarantees the standalone
// POST /jobs/:id/submit endpoint has always had.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import { registerAdapterFactory } from "../src/providers/factory.js";
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
    throw new Error(`fake db: unknown table ${name}`);
  }

  function selectRows(table: unknown, cond: unknown): Array<Record<string, unknown>> {
    const store = storeFor(table);
    const all = Array.from(store.values()).map((r) => ({ ...r }));
    if (cond === undefined) return all;
    const terms = walkPredicate(cond);
    return all.filter((r) => rowMatches(r, terms));
  }

  /** Joined-projection emulation for validateOwnership's innerJoin reads. */
  function withJoinProjection(table: unknown, rows: Array<Record<string, unknown>>) {
    const name = tableNameOf(table);
    if (name === "scenes") {
      for (const row of rows) {
        const episode = stores.episodes.get(row.episodeId as string);
        (row as any).projectId = episode ? episode.projectId : undefined;
      }
    } else if (name === "shots") {
      for (const row of rows) {
        const scene = stores.scenes.get(row.sceneId as string);
        const episode = scene ? stores.episodes.get(scene.episodeId as string) : undefined;
        (row as any).projectId = episode ? episode.projectId : undefined;
      }
    }
    return rows;
  }

  function snapshotAll(): Array<[string, [string, Record<string, unknown>]]> {
    const out: Array<[string, [string, Record<string, unknown>]]> = [];
    for (const [name, store] of Object.entries(stores)) {
      for (const [k, v] of (store as Map<string, Record<string, unknown>>).entries()) {
        out.push([name, [k, { ...v }]]);
      }
    }
    return out;
  }

  function restoreAll(snap: Array<[string, [string, Record<string, unknown>]]>): void {
    for (const store of Object.values(stores)) {
      (store as Map<string, Record<string, unknown>>).clear();
    }
    for (const [name, [k, v]] of snap) {
      (stores as any)[name].set(k, v);
    }
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
            base.rows = withJoinProjection(table, selectRows(table, cond));
            return {
              async for(_mode: string) {
                base.rows = withJoinProjection(table, selectRows(table, base.cond));
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
            base.rows = withJoinProjection(table, selectRows(table, base.cond));
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
      const run = async (): Promise<T> => {
        const snap = snapshotAll();
        try {
          return await cb(fakeDb);
        } catch (err) {
          restoreAll(snap);
          throw err;
        }
      };
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
  };
  setDb(makeFakeDb(stores));
  return stores;
}

function teardownDb() {
  setDb(null as any);
}

// --- Mock video provider ---------------------------------------------------

interface MockVideoAdapter {
  createJobCalls: Array<Record<string, unknown>>;
  setCreateJobFailure: (fn: ((i: number) => Error) | null) => void;
}

function installMockVideoAdapter(): MockVideoAdapter {
  const createJobCalls: Array<Record<string, unknown>> = [];
  let failure: ((i: number) => Error) | null = null;
  registerAdapterFactory("mock-video-c82", "Mock Video C82", ["video"], () => ({
    providerType: "mock-video-c82",
    name: "Mock Video C82",
    capabilities: ["video"],
    testConnection: async () => ({ ok: true }),
    createJob: async (params: any) => {
      createJobCalls.push({ ...params });
      if (failure) throw failure(createJobCalls.length - 1);
      return { externalJobId: `ext-${createJobCalls.length}` };
    },
    getJobStatus: async () => ({ status: "processing", progress: 40 }),
    cancelJob: async () => ({ cancelled: true }),
    downloadResult: async () => {
      throw new Error("downloadResult must never be called during C8.2 tests");
    },
  }));
  return {
    createJobCalls,
    setCreateJobFailure: (fn) => {
      failure = fn;
    },
  };
}

function seedVideoProviderAndModel(stores: Stores): { providerId: string; modelId: string } {
  const providerId = randomUUID();
  stores.aiProviders.set(providerId, {
    id: providerId,
    name: "Mock Video C82",
    providerType: "mock-video-c82",
    enabled: true,
    baseUrl: null,
    apiKeySecret: null,
    config: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const modelId = `${providerId}:model`;
  stores.aiModels.set(modelId, {
    id: modelId,
    providerId,
    name: "Video model",
    modelId: "mock-video-model-1",
    capability: "video",
    jobTypes: null,
    enabled: true,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { providerId, modelId };
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

async function seedProject(stores: Stores, cookie: string, name = "C8.2 Project"): Promise<string> {
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

type SeedJobOverrides = Partial<{
  status: string;
  jobType: string;
  projectId: string;
  sceneId: string;
  shotId: string | null;
  episodeId: string;
  providerId: string | null;
  modelId: string | null;
  prompt: string | null;
  metadata: Record<string, unknown> | null;
  externalJobId: string | null;
  error: string | null;
}>;

/**
 * Seeds a plan-generated ai_jobs row in the C8.1 shape: bound to the seeded
 * provider/model (C8.1's auto-routing persists that binding at creation
 * time) and carrying the plan provenance in metadata.
 */
function seedPlanJob(
  stores: Stores,
  planId: string,
  ctx: { projectId: string; episodeId: string; sceneId: string; shotId: string },
  overrides: SeedJobOverrides = {},
): string {
  const provider = Array.from(stores.aiProviders.values())[0];
  const model = Array.from(stores.aiModels.values())[0];
  const id = randomUUID();
  stores.aiJobs.set(id, {
    id,
    jobType: "text-to-video",
    status: "queued",
    providerId: provider ? (provider.id as string) : null,
    modelId: model ? (model.id as string) : null,
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
function seedApprovedPlanWithJobs(
  stores: Stores,
  projectId: string,
  episodeId: string,
  jobIds: string[],
  opts: { trackedSceneIds?: string[] } = {},
): string {
  const id = randomUUID();
  stores.productionPlans.set(id, {
    id,
    projectId,
    episodeId,
    request: "Make a 30-second Mozytoon episode about colors",
    status: "approved",
    // Default mirrors the real C7.4→C8.1 chain, which always records
    // `sceneIds`; tests that exercise the fail-closed path override it.
    plan: {
      [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: jobIds,
      sceneIds: opts.trackedSceneIds ?? Array.from(stores.scenes.keys()),
    },
    targetDurationSeconds: 30,
    preferences: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/**
 * Points the plan's durable C8.1 tracking list at jobs that were seeded
 * with the plan's real id (the /generate flow persists the payload after
 * creating the rows, so tests mirror that ordering). Other payload keys —
 * e.g. the C7.4 `sceneIds` the relationship verification reads — survive.
 */
function trackJobsInPlan(stores: Stores, planId: string, jobIds: string[]): void {
  const plan = stores.productionPlans.get(planId)!;
  const payload = plan.plan && typeof plan.plan === "object" && !Array.isArray(plan.plan)
    ? (plan.plan as Record<string, unknown>)
    : {};
  stores.productionPlans.set(planId, {
    ...plan,
    plan: { ...payload, [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: jobIds },
  });
}

async function execute(
  projectId: string,
  planId: string,
  cookie: string,
): Promise<{ status: number; body: { data?: any; error?: any } }> {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/execute`,
    { method: "POST", cookie },
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

async function withFetchTripwire<T>(fn: () => Promise<T>): Promise<{ result: T; tripwireHits: number }> {
  let tripwireHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    tripwireHits += 1;
    throw new Error("TRIPWIRE: external network call attempted during plan execution");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// 1. Successful execution initiation
// ---------------------------------------------------------------------------

test("C8.2 Execute - queued plan job is submitted through the existing executor", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const { providerId, modelId } = seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    // Job row first, then the plan whose tracking lists it (the C8.1 shape,
    // including the provider/model binding C8.1's auto-routing persists).
    const jobId = randomUUID();
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, [jobId]);
    stores.aiJobs.set(jobId, {
      id: jobId,
      jobType: "text-to-video",
      status: "queued",
      providerId,
      modelId,
      externalJobId: null,
      projectId,
      episodeId,
      sceneId,
      shotId,
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
    });

    const { result, tripwireHits } = await withFetchTripwire(() =>
      execute(projectId, planId, cookie),
    );
    assert.equal(tripwireHits, 0, "no direct network call may occur");
    assert.equal(result.status, 200);

    const report = result.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.jobType, "text-to-video");
    assert.equal(report.submitted.length, 1);
    assert.equal(report.submitted[0].jobId, jobId);
    assert.equal(report.submitted[0].status, "submitted");
    assert.equal(report.submitted[0].shotId, shotId);
    assert.equal(report.submitted[0].sceneId, sceneId);
    assert.equal(report.alreadyActive.length, 0);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.failed.length, 0);

    // The executor ran: provider createJob was called via the executor path,
    // and the job row transitioned queued → submitted with external id.
    assert.equal(mock.createJobCalls.length, 1);
    const jobRow = stores.aiJobs.get(jobId)!;
    assert.equal(jobRow.status, "submitted");
    assert.equal(jobRow.externalJobId, "ext-1");
    assert.equal(jobRow.providerId, providerId);
    assert.equal(jobRow.modelId, modelId);

    // No new job rows were created by this endpoint.
    assert.equal(stores.aiJobs.size, 1);
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - multiple queued jobs submit independently", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const scene1 = seedScene(stores, episodeId, 1);
    const scene2 = seedScene(stores, episodeId, 2);
    const shotA = seedShot(stores, scene1, 1);
    const shotB = seedShot(stores, scene2, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const jobA = seedPlanJob(stores, planId, { projectId, episodeId, sceneId: scene1, shotId: shotA });
    const jobB = seedPlanJob(stores, planId, { projectId, episodeId, sceneId: scene2, shotId: shotB });
    trackJobsInPlan(stores, planId, [jobA, jobB]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.submitted.length, 2);
    assert.deepEqual(
      report.submitted.map((s: any) => s.jobId).sort(),
      [jobA, jobB].sort(),
    );
    assert.equal(stores.aiJobs.size, 2);
    assert.ok(
      Array.from(stores.aiJobs.values()).every((j) => j.status === "submitted"),
    );
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Approval gate + ownership
// ---------------------------------------------------------------------------

test("C8.2 Execute - non-approved plans are rejected with 409", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = randomUUID();
    stores.productionPlans.set(planId, {
      id: planId,
      projectId,
      episodeId,
      request: "req",
      status: "ready_for_review",
      plan: { [PRODUCTION_PLAN_GENERATED_JOB_IDS_KEY]: ["j1"] },
      targetDurationSeconds: null,
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 409);
    assert.match(res.body.error!.message, /approved/);
    assert.equal(res.body.error!.code, "CONFLICT");
    assert.equal(stores.aiJobs.get(jobIdOf(stores))!.status, "queued");
  } finally {
    teardownDb();
  }
});

function jobIdOf(stores: Stores): string {
  return Array.from(stores.aiJobs.keys())[0]!;
}

test("C8.2 Execute - foreign project and wrong-project plan are invisible", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const ownerCookie = await userSession(stores, "owner@example.com");
    const projectId = await seedProject(stores, ownerCookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const jobId = seedPlanJob(stores, "plan-x", { projectId, episodeId, sceneId, shotId });
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, [jobId]);

    const intruder = await userSession(stores, "intruder@example.com");
    const foreignProject = await execute(projectId, planId, intruder);
    assert.equal(foreignProject.status, 404);
    assert.equal(foreignProject.body.error!.message, "Project not found");

    const projectB = await seedProject(stores, ownerCookie, "B");
    const wrongProject = await execute(projectB, planId, ownerCookie);
    assert.equal(wrongProject.status, 404);
    assert.equal(wrongProject.body.error!.message, "Production plan not found");

    const missing = await execute(projectId, randomUUID(), ownerCookie);
    assert.equal(missing.status, 404);

    // The executor was never reached; the job stays queued.
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Tracked job resolution and context verification
// ---------------------------------------------------------------------------

test("C8.2 Execute - a tracked job id that no longer resolves is skipped", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, [randomUUID()]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].status, null);
    assert.match(report.skipped[0].reason, /no longer exists/);
    assert.equal(report.submitted.length, 0);
    // No job row was conjured for the missing id.
    assert.equal(stores.aiJobs.size, 0);
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - a tracked job whose context no longer matches is skipped", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const projectB = await seedProject(stores, cookie, "B");
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);

    // Job rows whose project / provenance / type no longer match the plan.
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
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
      metadata: null, // manual C6 job — never hijacked
    });
    const wrongTypeJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    stores.aiJobs.set(wrongTypeJob, {
      ...stores.aiJobs.get(wrongTypeJob)!,
      jobType: "text-to-image",
    });
    trackJobsInPlan(stores, planId, [foreignProjectJob, wrongPlanJob, manualJob, wrongTypeJob]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.skipped.length, 4);
    for (const entry of report.skipped) {
      assert.match(entry.reason, /no longer belongs to this production plan's context/);
    }
    assert.deepEqual(
      report.skipped.map((s: any) => s.jobId).sort(),
      [foreignProjectJob, wrongPlanJob, manualJob, wrongTypeJob].sort(),
    );
    assert.equal(report.submitted.length, 0);
    // Nothing was executed.
    for (const id of [foreignProjectJob, wrongPlanJob, manualJob, wrongTypeJob]) {
      assert.equal(stores.aiJobs.get(id)!.status, "queued");
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3b. Shot/scene relationship verification (C8.2 hardening)
// ---------------------------------------------------------------------------

test("C8.2 Execute - a tracked job whose shot no longer exists is skipped", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, [], { trackedSceneIds: [sceneId] });
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: randomUUID() });
    trackJobsInPlan(stores, planId, [jobId]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].jobId, jobId);
    assert.match(report.skipped[0].reason, /shot no longer exists/);
    // No provider submission for the dangling reference.
    assert.equal(mock.createJobCalls.length, 0);
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued");
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - a tracked job whose shot belongs to another project is skipped", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, [], { trackedSceneIds: [sceneId] });
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: randomUUID() });
    trackJobsInPlan(stores, planId, [jobId]);

    // A second project's episode/scene/shot chain: the job's shot/scene
    // now live inside project B's episode — internally consistent, but not
    // inside the requesting project.
    const projectB = await seedProject(stores, cookie, "B");
    const episodeB = seedEpisode(stores, projectB);
    const sceneB = seedScene(stores, episodeB, 1);
    const shotB = seedShot(stores, sceneB, 1);
    stores.aiJobs.set(jobId, {
      ...stores.aiJobs.get(jobId)!,
      sceneId: sceneB,
      shotId: shotB,
    });

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.skipped.length, 1);
    assert.match(
      report.skipped[0].reason,
      /scene no longer belongs to the production plan's episode and project/,
    );
    // The report names the broken relationship, never the foreign records.
    const reportJson = JSON.stringify(report);
    assert.ok(!reportJson.includes(projectB));
    assert.ok(!reportJson.includes(episodeB));
    assert.ok(!reportJson.includes(sceneB));
    assert.ok(!reportJson.includes(shotB));
    assert.equal(mock.createJobCalls.length, 0);
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued");
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - a tracked job whose scene is not tracked by the plan is skipped", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const trackedSceneId = seedScene(stores, episodeId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, [], {
      trackedSceneIds: [trackedSceneId],
    });
    const jobId = seedPlanJob(stores, planId, {
      projectId,
      episodeId,
      sceneId: trackedSceneId,
      shotId: randomUUID(),
    });
    trackJobsInPlan(stores, planId, [jobId]);

    // The shot exists and its chain is internally consistent — but it sits
    // in a scene the plan does not track.
    const untrackedSceneId = seedScene(stores, episodeId, 2);
    const movedShotId = seedShot(stores, untrackedSceneId, 1);
    stores.aiJobs.set(jobId, {
      ...stores.aiJobs.get(jobId)!,
      sceneId: untrackedSceneId,
      shotId: movedShotId,
    });

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /not tracked by this production plan/);
    assert.equal(mock.createJobCalls.length, 0);
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued");
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - a plan with no recoverable tracked-scene set never submits (fail closed)", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    // A payload with generatedJobIds but NO sceneIds — a corrupted or
    // hand-edited plan. Membership cannot be proven, so the job must not
    // run even though the shot/scene chain is otherwise intact.
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, [], {
      trackedSceneIds: undefined,
    });
    const payload = stores.productionPlans.get(planId)!.plan as Record<string, unknown>;
    delete payload.sceneIds; // simulate the corrupted/edited payload
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    trackJobsInPlan(stores, planId, [jobId]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.skipped.length, 1);
    assert.equal(report.submitted.length, 0);
    assert.equal(report.failed.length, 0);
    assert.match(
      report.skipped[0].reason,
      /does not record the tracked scene set/,
    );
    // Fail closed: no provider submission, job row untouched.
    assert.equal(mock.createJobCalls.length, 0);
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued");
    assert.equal(stores.aiJobs.size, 1);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Active and terminal jobs
// ---------------------------------------------------------------------------

test("C8.2 Execute - submitted and processing jobs are not submitted twice", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);

    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const submittedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA }, {
      status: "submitted",
      providerId: "p",
      modelId: "m",
      externalJobId: "ext-42",
    });
    const processingJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotB }, {
      status: "processing",
      providerId: "p",
      modelId: "m",
      externalJobId: "ext-43",
    });
    trackJobsInPlan(stores, planId, [submittedJob, processingJob]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.alreadyActive.length, 2);
    assert.deepEqual(
      report.alreadyActive.map((a: any) => a.jobId).sort(),
      [submittedJob, processingJob].sort(),
    );
    assert.equal(report.alreadyActive[0].outcome, "already_active");
    // The provider was never called; rows untouched.
    assert.equal(mock.createJobCalls.length, 0);
    assert.equal(stores.aiJobs.get(submittedJob)!.status, "submitted");
    assert.equal(stores.aiJobs.get(processingJob)!.status, "processing");
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - terminal jobs are skipped, never auto-regenerated", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);
    const shotC = seedShot(stores, sceneId, 3);

    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const completedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA }, {
      status: "completed",
    });
    const failedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotB }, {
      status: "failed",
      error: "provider exploded",
    });
    const cancelledJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotC }, {
      status: "cancelled",
    });
    trackJobsInPlan(stores, planId, [completedJob, failedJob, cancelledJob]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.skipped.length, 3);
    for (const entry of report.skipped) {
      assert.match(entry.reason, /terminal status/);
      assert.match(entry.reason, /will not be regenerated/);
    }
    assert.equal(report.submitted.length, 0);
    assert.equal(report.failed.length, 0);
    // Provider never called; no replacement jobs were created.
    assert.equal(mock.createJobCalls.length, 0);
    assert.equal(stores.aiJobs.size, 3);
    assert.equal(stores.aiJobs.get(completedJob)!.status, "completed");
    assert.equal(stores.aiJobs.get(failedJob)!.status, "failed");
    assert.equal(stores.aiJobs.get(cancelledJob)!.status, "cancelled");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Executor configuration and provider failure paths
// ---------------------------------------------------------------------------

test("C8.2 Execute - provider submission failure is reported accurately", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    trackJobsInPlan(stores, planId, [jobId]);

    // Executor converts provider errors into a failed job (queued → failed)
    // with a sanitized persisted error; the report reflects that outcome.
    mock.setCreateJobFailure(() =>
      Object.assign(new Error("upstream exploded apiKey=sk-super-secret https://provider.example/v1/jobs"), {
        name: "ProviderError",
      }),
    );

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].jobId, jobId);
    assert.equal(report.failed[0].status, "failed");
    // The sanitized executor error is surfaced — no URL, no key material.
    const reason = report.failed[0].reason as string;
    assert.ok(!reason.includes("sk-super-secret"), "api key must be redacted");
    assert.ok(!reason.includes("provider.example"), "urls must be redacted");
    // The job row was transitioned by the executor, not created anew.
    const row = stores.aiJobs.get(jobId)!;
    assert.equal(row.status, "failed");
    assert.ok(String(row.error).includes("[redacted]"));
    assert.equal(stores.aiJobs.size, 1);
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - missing provider/model configuration fails that job with a sanitized reason", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const { providerId } = seedVideoProviderAndModel(stores);

    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    trackJobsInPlan(stores, planId, [jobId]);
    stores.aiProviders.delete(providerId); // provider record vanished after creation

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].reason, /not found in database/);
    // Job row untouched by this endpoint (executor rejected before any write).
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued");
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - unsupported job type is context-skipped, never executed", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId }, {
      jobType: "text-to-image",
    });
    trackJobsInPlan(stores, planId, [jobId]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /no longer belongs/);
    assert.equal(mock.createJobCalls.length, 0);
    assert.equal(stores.aiJobs.get(jobId)!.status, "queued");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Partial success + repeated requests
// ---------------------------------------------------------------------------

test("C8.2 Execute - partial success across mixed job states", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const shotB = seedShot(stores, sceneId, 2);
    const shotC = seedShot(stores, sceneId, 3);
    const shotD = seedShot(stores, sceneId, 4);

    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const queuedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotA }, {});
    const processingJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotB }, {
      status: "processing",
      providerId: "p",
      modelId: "m",
      externalJobId: "ext-9",
    });
    const completedJob = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId: shotC }, {
      status: "completed",
    });
    const missingId = randomUUID();
    trackJobsInPlan(stores, planId, [queuedJob, processingJob, completedJob, missingId]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "partial");
    assert.equal(report.submitted.length, 1);
    assert.equal(report.submitted[0].jobId, queuedJob);
    assert.equal(report.alreadyActive.length, 1);
    assert.equal(report.alreadyActive[0].jobId, processingJob);
    assert.equal(report.skipped.length, 2);
    const skippedIds = report.skipped.map((s: any) => s.jobId).sort();
    assert.deepEqual(skippedIds, [completedJob, missingId].sort());
    assert.equal(report.failed.length, 0);
    assert.equal(stores.aiJobs.size, 3);
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - repeated requests never double-submit active jobs", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    trackJobsInPlan(stores, planId, [jobId]);

    const first = await execute(projectId, planId, cookie);
    assert.equal(first.status, 200);
    assert.equal(first.body.data!.submitted.length, 1);

    const second = await execute(projectId, planId, cookie);
    assert.equal(second.status, 200);
    const report = second.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.submitted.length, 0, "a submitted job is never submitted again");
    assert.equal(report.alreadyActive.length, 1);
    assert.equal(report.alreadyActive[0].jobId, jobId);
    assert.equal(report.failed.length, 0);
    assert.equal(report.skipped.length, 0);

    // Still exactly one job row, still submitted, provider called once.
    assert.equal(stores.aiJobs.size, 1);
    assert.equal(stores.aiJobs.get(jobId)!.status, "submitted");
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - plan without tracked jobs is rejected with 400", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error!.message, /no tracked generation jobs/);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7. Lifecycle boundaries
// ---------------------------------------------------------------------------

test("C8.2 Execute - polling and persistence stay in the existing lifecycle", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotId = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlanWithJobs(stores, projectId, episodeId, []);
    const jobId = seedPlanJob(stores, planId, { projectId, episodeId, sceneId, shotId });
    trackJobsInPlan(stores, planId, [jobId]);

    const res = await execute(projectId, planId, cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.data!.submitted.length, 1);

    // The job is only submitted: no polling happened during execute (the
    // mock's getJobStatus was never called — it would have thrown if it
    // were, since execute must not poll). The executor submit path is the
    // only provider touch, and the row is in the intermediate state.
    const row = stores.aiJobs.get(jobId)!;
    assert.equal(row.status, "submitted");
    assert.equal(row.assetVersionId, null, "no asset persistence during execution initiation");
    assert.equal(mock.createJobCalls.length, 1);

    // The existing lifecycle remains responsible for the next step.
    const pollRes = await jsonRequest(`/api/v1/jobs/${jobId}/poll`, { method: "POST", cookie });
    assert.equal(pollRes.status, 200);
    const polled = ((await pollRes.json()) as { data: any }).data;
    assert.equal(polled.status, "processing");
    assert.equal(polled.progress, 40);
  } finally {
    teardownDb();
  }
});

test("C8.2 Execute - error responses use the API envelope without leaking secrets", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);

    // Non-approved plan error envelope.
    const reviewPlanId = randomUUID();
    stores.productionPlans.set(reviewPlanId, {
      id: reviewPlanId,
      projectId,
      episodeId,
      request: "req",
      status: "planning",
      plan: null,
      targetDurationSeconds: null,
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await execute(projectId, reviewPlanId, cookie);
    assert.equal(res.status, 409);
    const body = res.body.error!;
    assert.equal(typeof body.code, "string");
    assert.equal(typeof body.message, "string");
    assert.ok(!JSON.stringify(body).toLowerCase().includes("apikey"));
    assert.ok(!JSON.stringify(body).includes("sk-"));
  } finally {
    teardownDb();
  }
});
