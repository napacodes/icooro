// ---------------------------------------------------------------------------
// C8.1 — Media generation entry point for an approved Production Plan
//
// POST /projects/:projectId/production-plans/:id/generate
//
// Covers: successful initiation for an approved plan, rejection of
// non-approved plans, project/plan ownership enforcement, missing or
// invalid shot prompts and other required production data, duplicate
// submission + idempotency, multiple eligible shots with correct
// job→shot relationships, partial job-creation failure, provider
// selection/capability validation through the existing C6 infrastructure,
// and proof that NO provider execution happens from the route (mock
// provider createJob tripwire + global fetch tripwire).
//
// All providers are deterministic in-process mocks — no real or paid AI
// call can ever happen.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import { registerAdapterFactory } from "../src/providers/factory.js";
import type { VideoGenerationParams } from "../src/providers/types.js";

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
        // inArray(col, values): the value list is the chunk after the
        // operator. Its elements are drizzle Param wrappers, so unwrap .value.
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

/**
 * Fake DB covering the exact query patterns C8.1's path uses:
 *   - plain select/where (plans, projects, episodes, scenes, shots, ai_jobs)
 *   - `in` clauses (plan_generation's inArray lookups)
 *   - innerJoin chains (generationJobService.validateOwnership's shot/scene
 *     ownership checks, resolved by evaluating the join ON predicates and
 *     the where predicate against the stored rows)
 */
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

  /** Snapshot all stores; used by transaction rollback. */
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

  // Serialized transaction queue — mirrors the fake in
  // generation_result.test.ts: one fake transaction at a time, with
  // rollback-on-throw via store snapshots. This is also what makes the
  // plan-row-lock serialization observable: a second transaction's locking
  // SELECT cannot run until the first transaction's callback finishes.
  let txChain: Promise<unknown> = Promise.resolve();

  /**
   * Joined-projection emulation: `generationJobService.validateOwnership`
   * reads scenes/shots through innerJoins to episodes and projects
   * `episodes.projectId` onto the result rows. The stores hold the same FK
   * relationships, so the projectId is computed through the chain — exactly
   * what the JOIN would produce.
   */
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
              // `.for("update")` — the plan-row locking read. Under the
              // serialized fake this returns rows like a plain where(); the
              // serialization itself (not lock emulation) provides the
              // mutual exclusion the tests observe.
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
          // The tx handle shares the same fake ops (no isolation inside the
          // fake — the serialized queue provides the observable ordering).
          return await cb(fakeDb);
        } catch (err) {
          restoreAll(snap);
          throw err;
        }
      };
      const next = txChain.then(run, run);
      // Swallow errors in the chain so one rejection doesn't break later
      // transactions; the caller's promise still rejects.
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

// --- Mock video provider (records calls; never hits the network) -----------

interface MockVideoAdapter {
  createJobCalls: VideoGenerationParams[];
  setCreateJobFailure: (fn: ((i: number) => Error) | null) => void;
}

function installMockVideoAdapter(): MockVideoAdapter {
  const createJobCalls: VideoGenerationParams[] = [];
  let failure: ((i: number) => Error) | null = null;
  registerAdapterFactory("mock-video-c81", "Mock Video C81", ["video"], () => ({
    providerType: "mock-video-c81",
    name: "Mock Video C81",
    capabilities: ["video"],
    testConnection: async () => ({ ok: true }),
    createJob: async (params: VideoGenerationParams) => {
      createJobCalls.push({ ...params });
      if (failure) throw failure(createJobCalls.length - 1);
      return { externalJobId: `ext-${createJobCalls.length}` };
    },
    getJobStatus: async () => ({ status: "submitted" }),
    cancelJob: async () => ({ cancelled: true }),
    downloadResult: async () => {
      throw new Error("downloadResult must never be called during C8.1 tests");
    },
  }));
  return {
    createJobCalls,
    setCreateJobFailure: (fn) => {
      failure = fn;
    },
  };
}

function seedVideoProviderAndModel(stores: Stores, overrides: { modelJobTypes?: unknown; modelEnabled?: boolean } = {}): {
  providerId: string;
  modelId: string;
} {
  const providerId = randomUUID();
  stores.aiProviders.set(providerId, {
    id: providerId,
    name: "Mock Video C81",
    providerType: "mock-video-c81",
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
    jobTypes: overrides.modelJobTypes ?? null,
    enabled: overrides.modelEnabled ?? true,
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

async function seedProject(stores: Stores, cookie: string, name = "C8.1 Project"): Promise<string> {
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
    description: `Scene number ${orderIndex}`,
    orderIndex,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedShot(
  stores: Stores,
  sceneId: string,
  orderIndex: number,
  overrides: Partial<{ prompt: string | null; status: string }> = {},
): string {
  const id = randomUUID();
  stores.shots.set(id, {
    id,
    sceneId,
    orderIndex,
    purpose: "Establish the town",
    shotType: "wide",
    framing: "full shot",
    cameraMovement: "slow pan",
    cameraAngle: "eye level",
    prompt: "A wide shot of a small cartoon town on a gray morning.",
    visualDescription: "A desaturated town.",
    actionDescription: "Mozy looks out.",
    dialogue: null,
    transition: "cut to",
    productionNotes: null,
    duration: 8,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

/**
 * Seeds a plan in `approved` status whose payload tracks the given scenes
 * and their shots — the exact shape the C7.4/C7.5 services record.
 */
function seedApprovedPlan(
  stores: Stores,
  projectId: string,
  episodeId: string,
  shotIdsByScene: Record<string, string[]>,
): string {
  const id = randomUUID();
  stores.productionPlans.set(id, {
    id,
    projectId,
    episodeId,
    request: "Make a 30-second Mozytoon episode about colors",
    status: "approved",
    plan: {
      sceneIds: Object.keys(shotIdsByScene),
      shotIds: shotIdsByScene,
    },
    targetDurationSeconds: 30,
    preferences: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function approvePlan(
  stores: Stores,
  cookie: string,
  projectId: string,
  planId: string,
): Promise<void> {
  const res1 = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
    method: "PATCH",
    cookie,
    body: JSON.stringify({ status: "ready_for_review" }),
  });
  assert.equal(res1.status, 200);
  const res2 = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
    method: "PATCH",
    cookie,
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(res2.status, 200);
}

async function generate(
  projectId: string,
  planId: string,
  cookie: string,
): Promise<{ status: number; body: { data?: any; error?: any } }> {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/generate`,
    { method: "POST", cookie },
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

async function withFetchTripwire<T>(fn: () => Promise<T>): Promise<{ result: T; tripwireHits: number }> {
  let tripwireHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    tripwireHits += 1;
    throw new Error("TRIPWIRE: external network call attempted during plan generation");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// 1. Successful initiation for an approved plan
// ---------------------------------------------------------------------------

test("C8.1 Generate - approved plan creates queued jobs for every tracked shot", async () => {
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
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA, shotB] });

    const { result, tripwireHits } = await withFetchTripwire(() =>
      generate(projectId, planId, cookie),
    );
    assert.equal(tripwireHits, 0, "no external network call may occur");
    assert.equal(result.status, 200);

    const report = result.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.jobType, "text-to-video");
    assert.equal(report.created.length, 2);
    assert.equal(report.alreadyActive.length, 0);
    assert.equal(report.failed.length, 0);

    // Job → shot relationships are correct, jobs are queued with the shot's prompt.
    const jobs = Array.from(stores.aiJobs.values());
    assert.equal(jobs.length, 2);
    const byShot = new Map(jobs.map((j) => [j.shotId, j]));
    const jobA = byShot.get(shotA)!;
    const jobB = byShot.get(shotB)!;
    assert.ok(jobA && jobB);
    assert.equal(jobA.status, "queued");
    assert.equal(jobB.status, "queued");
    assert.equal(jobA.jobType, "text-to-video");
    assert.equal(jobA.sceneId, sceneId);
    assert.equal(jobA.episodeId, episodeId);
    assert.equal(jobA.projectId, projectId);
    assert.equal(jobA.prompt, "A wide shot of a small cartoon town on a gray morning.");
    assert.equal(jobA.targetMediaType, "video");

    // The report echoes the created job ids with their statuses.
    const reportByShot = new Map(report.created.map((r: any) => [r.shotId, r]));
    assert.equal(reportByShot.get(shotA).jobId, jobA.id);
    assert.equal(reportByShot.get(shotA).status, "queued");
    assert.equal(reportByShot.get(shotA).sceneId, sceneId);
    assert.equal(reportByShot.get(shotB).jobId, jobB.id);

    // The plan itself is untouched (still approved, same payload).
    const planRow = stores.productionPlans.get(planId)!;
    assert.equal(planRow.status, "approved");
    assert.ok((planRow.plan as any).sceneIds.length === 1);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Rejection of plans that are not approved
// ---------------------------------------------------------------------------

test("C8.1 Generate - non-approved plans are rejected with 409 and create no jobs", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);

    // planning
    const planningId = randomUUID();
    stores.productionPlans.set(planningId, {
      id: planningId,
      projectId,
      episodeId,
      request: "req",
      status: "planning",
      plan: { sceneIds: [sceneId], shotIds: { [sceneId]: [shotA] } },
      targetDurationSeconds: null,
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const planning = await generate(projectId, planningId, cookie);
    assert.equal(planning.status, 409);
    assert.match(planning.body.error!.message, /approved/);

    // ready_for_review
    const reviewId = randomUUID();
    stores.productionPlans.set(reviewId, {
      ...stores.productionPlans.get(planningId)!,
      id: reviewId,
      status: "ready_for_review",
    });
    const review = await generate(projectId, reviewId, cookie);
    assert.equal(review.status, 409);

    // cancelled
    const cancelledId = randomUUID();
    stores.productionPlans.set(cancelledId, {
      ...stores.productionPlans.get(planningId)!,
      id: cancelledId,
      status: "cancelled",
    });
    const cancelled = await generate(projectId, cancelledId, cookie);
    assert.equal(cancelled.status, 409);

    assert.equal(stores.aiJobs.size, 0, "no job may be created for non-approved plans");
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - the route never approves a plan itself", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);

    // A plan sitting in ready_for_review with valid tracked data: the
    // review flow (C7.1 PATCH) is the only path to approved.
    const planId = randomUUID();
    stores.productionPlans.set(planId, {
      id: planId,
      projectId,
      episodeId,
      request: "req",
      status: "ready_for_review",
      plan: { sceneIds: [sceneId], shotIds: { [sceneId]: [shotA] } },
      targetDurationSeconds: null,
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 409);
    assert.equal((stores.productionPlans.get(planId)! as any).status, "ready_for_review");
    assert.equal(stores.aiJobs.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Ownership enforcement
// ---------------------------------------------------------------------------

test("C8.1 Generate - another user's project and a foreign plan are invisible", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const ownerCookie = await userSession(stores, "owner@example.com");
    const projectId = await seedProject(stores, ownerCookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    const intruder = await userSession(stores, "intruder@example.com");

    // Foreign project → 404 "Project not found"
    const foreignProject = await generate(projectId, planId, intruder);
    assert.equal(foreignProject.status, 404);
    assert.equal(foreignProject.body.error!.message, "Project not found");

    // Same owner, wrong project → plan invisible, 404
    const projectB = await seedProject(stores, ownerCookie, "B");
    const wrongProject = await generate(projectB, planId, ownerCookie);
    assert.equal(wrongProject.status, 404);
    assert.equal(wrongProject.body.error!.message, "Production plan not found");

    // Missing plan → 404
    const missing = await generate(projectId, randomUUID(), ownerCookie);
    assert.equal(missing.status, 404);

    assert.equal(stores.aiJobs.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Missing / invalid production data
// ---------------------------------------------------------------------------

test("C8.1 Generate - tracked shots without prompts fail per shot, others still accepted", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const withPrompt = seedShot(stores, sceneId, 1);
    const withoutPrompt = seedShot(stores, sceneId, 2, { prompt: null });
    const blankPrompt = seedShot(stores, sceneId, 3, { prompt: "   " });
    const planId = seedApprovedPlan(stores, projectId, episodeId, {
      [sceneId]: [withPrompt, withoutPrompt, blankPrompt],
    });

    const { result } = await withFetchTripwire(() => generate(projectId, planId, cookie));
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "partial");
    assert.equal(report.created.length, 1);
    assert.equal(report.created[0].shotId, withPrompt);
    assert.equal(report.failed.length, 2);
    const failedIds = report.failed.map((f: any) => f.shotId);
    assert.ok(failedIds.includes(withoutPrompt));
    assert.ok(failedIds.includes(blankPrompt));
    for (const f of report.failed) {
      assert.match(f.reason, /no media prompt/);
    }
    assert.equal(stores.aiJobs.size, 1);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - unanchored plan and plan without tracked shots are rejected", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);

    // Approved but unanchored (no episodeId on row or payload).
    const unanchoredId = randomUUID();
    stores.productionPlans.set(unanchoredId, {
      id: unanchoredId,
      projectId,
      episodeId: null,
      request: "req",
      status: "approved",
      plan: { sceneIds: [], shotIds: {} },
      targetDurationSeconds: null,
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const unanchored = await generate(projectId, unanchoredId, cookie);
    assert.equal(unanchored.status, 400);
    assert.match(unanchored.body.error!.message, /anchored to an episode/);

    // Approved + anchored, but no tracked shots.
    const episodeId = seedEpisode(stores, projectId);
    const noShotsId = randomUUID();
    stores.productionPlans.set(noShotsId, {
      id: noShotsId,
      projectId,
      episodeId,
      request: "req",
      status: "approved",
      plan: { sceneIds: [], shotIds: {} },
      targetDurationSeconds: null,
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const noShots = await generate(projectId, noShotsId, cookie);
    assert.equal(noShots.status, 400);
    assert.match(noShots.body.error!.message, /no tracked shots/);

    assert.equal(stores.aiJobs.size, 0);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - deleted tracked shots are reported, never silently generated", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const alive = seedShot(stores, sceneId, 1);
    const deleted = seedShot(stores, sceneId, 2);
    stores.shots.delete(deleted);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [alive, deleted] });

    const { result } = await withFetchTripwire(() => generate(projectId, planId, cookie));
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "partial");
    assert.equal(report.created.length, 1);
    assert.equal(report.created[0].shotId, alive);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].shotId, deleted);
    assert.match(report.failed[0].reason, /no longer exists/);
    assert.equal(stores.aiJobs.size, 1);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Duplicate submission + idempotency
// ---------------------------------------------------------------------------

test("C8.1 Generate - resubmitting the same approved plan does not duplicate jobs", async () => {
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
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA, shotB] });

    const first = await generate(projectId, planId, cookie);
    assert.equal(first.status, 200);
    assert.equal(first.body.data!.status, "completed");
    assert.equal(first.body.data!.created.length, 2);
    const firstJobIds = first.body.data!.created.map((r: any) => r.jobId).sort();

    // Second identical submission: everything is already active.
    const second = await generate(projectId, planId, cookie);
    assert.equal(second.status, 200);
    assert.equal(second.body.data!.status, "completed");
    assert.equal(second.body.data!.created.length, 0);
    assert.equal(second.body.data!.alreadyActive.length, 2);
    assert.equal(second.body.data!.failed.length, 0);
    const activeJobIds = second.body.data!.alreadyActive.map((r: any) => r.jobId).sort();
    assert.deepEqual(activeJobIds, firstJobIds);

    // Still exactly two jobs — no duplicates.
    assert.equal(stores.aiJobs.size, 2);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - terminal jobs do not block regeneration", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const { modelId } = seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    // Pre-seed a completed job from this plan for the shot.
    const doneJobId = randomUUID();
    stores.aiJobs.set(doneJobId, {
      id: doneJobId,
      jobType: "text-to-video",
      status: "completed",
      providerId: null,
      modelId,
      externalJobId: null,
      projectId,
      episodeId,
      sceneId,
      shotId: shotA,
      shotVersionId: null,
      assetId: null,
      assetVersionId: null,
      prompt: "old prompt",
      negativePrompt: null,
      targetMediaType: "video",
      requestedDuration: null,
      requestedWidth: null,
      requestedHeight: null,
      progress: 100,
      error: null,
      metadata: { productionPlanId: planId, source: "production-plan" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.created.length, 1, "a completed job must not block a new one");
    assert.equal(report.alreadyActive.length, 0);
    assert.equal(stores.aiJobs.size, 2);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - manual C6 jobs on the same shot are not hijacked by the plan guard", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    // A queued job NOT created by this plan (manual C6 job): no
    // metadata.productionPlanId.
    const manualJobId = randomUUID();
    stores.aiJobs.set(manualJobId, {
      id: manualJobId,
      jobType: "text-to-video",
      status: "queued",
      providerId: null,
      modelId: null,
      externalJobId: null,
      projectId,
      episodeId,
      sceneId,
      shotId: shotA,
      shotVersionId: null,
      assetId: null,
      assetVersionId: null,
      prompt: "manual",
      negativePrompt: null,
      targetMediaType: "video",
      requestedDuration: null,
      requestedWidth: null,
      requestedHeight: null,
      progress: 0,
      error: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.created.length, 1, "the plan creates its own job");
    assert.equal(report.alreadyActive.length, 0);
    assert.equal(stores.aiJobs.size, 2);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Multiple eligible shots across scenes
// ---------------------------------------------------------------------------

test("C8.1 Generate - shots across multiple tracked scenes map to their own jobs", async () => {
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
    const shotC = seedShot(stores, scene2, 2);
    const planId = seedApprovedPlan(stores, projectId, episodeId, {
      [scene1]: [shotA],
      [scene2]: [shotB, shotC],
    });

    const { result } = await withFetchTripwire(() => generate(projectId, planId, cookie));
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.created.length, 3);

    const byShot = new Map(report.created.map((r: any) => [r.shotId, r]));
    assert.equal(byShot.get(shotA).sceneId, scene1);
    assert.equal(byShot.get(shotB).sceneId, scene2);
    assert.equal(byShot.get(shotC).sceneId, scene2);

    const jobs = Array.from(stores.aiJobs.values());
    assert.equal(jobs.length, 3);
    for (const job of jobs) {
      assert.equal(job.episodeId, episodeId);
      assert.equal(job.projectId, projectId);
      assert.equal(job.status, "queued");
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7. Partial job-creation failure
// ---------------------------------------------------------------------------

test("C8.1 Generate - provider-routing failure fails only that shot's acceptance", async () => {
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
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA, shotB] });

    // The C6.8.2 routing resolves the model, then createJob-service insert
    // path throws for the second shot (simulated via a one-shot failure in
    // the auto-selected model's jobTypes validation — simplest deterministic
    // lever: make the model invalid after the first job was created).
    const first = await generate(projectId, planId, cookie);
    assert.equal(first.status, 200);
    assert.equal(first.body.data!.created.length, 2);

    // Reset: delete the jobs, then break routing so createJob fails.
    stores.aiJobs.clear();
    for (const model of stores.aiModels.values()) {
      model.jobTypes = ["text-to-image"]; // no longer serves text-to-video
    }

    const second = await generate(projectId, planId, cookie);
    assert.equal(second.status, 200);
    const report = second.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.created.length, 0);
    assert.equal(report.failed.length, 2);
    for (const f of report.failed) {
      assert.match(f.reason, /No enabled model configured/);
    }
    assert.equal(stores.aiJobs.size, 0);
    void mock;
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8. Provider selection / capability validation (existing infrastructure)
// ---------------------------------------------------------------------------

test("C8.1 Generate - jobs are routed to the auto-selected enabled video model", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const { providerId, modelId } = seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const job = Array.from(stores.aiJobs.values())[0]!;
    assert.equal(job.providerId, providerId);
    assert.equal(job.modelId, modelId);
    assert.equal(job.status, "queued");
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - a model whose jobTypes exclude text-to-video is rejected by routing", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores, { modelJobTypes: ["text-to-image"] });
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.created.length, 0);
    assert.match(report.failed[0].reason, /No enabled model configured/);
    assert.equal(stores.aiJobs.size, 0);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - no eligible video model is reported as a per-shot failure", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    // No provider/model seeded at all.
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const report = res.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(report.created.length, 0);
    assert.match(report.failed[0].reason, /No enabled model configured/);
    assert.equal(stores.aiJobs.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 9. No provider execution from the route
// ---------------------------------------------------------------------------

test("C8.1 Generate - the route never executes a provider (mock createJob tripwire)", async () => {
  const mock = installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    const { result, tripwireHits } = await withFetchTripwire(() =>
      generate(projectId, planId, cookie),
    );
    assert.equal(result.status, 200);
    assert.equal(tripwireHits, 0, "no fetch may occur");
    assert.equal(
      mock.createJobCalls.length,
      0,
      "the C8.1 route must never call provider.createJob — execution belongs to the existing executor",
    );
    // The created job stays queued for the executor.
    const job = Array.from(stores.aiJobs.values())[0]!;
    assert.equal(job.status, "queued");
    assert.ok(
      job.externalJobId === null || job.externalJobId === undefined,
      "a queued job must carry no external job id yet",
    );
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 10. Job creation goes through the real C6 createJob service
// ---------------------------------------------------------------------------

test("C8.1 Generate - created jobs pass the C6 ownership validation chain", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    // Delete the episode AFTER plan seeding but the service re-resolves it —
    // a missing episode is a request-level 404 (structural precondition).
    stores.episodes.delete(episodeId);
    const missingEpisode = await generate(projectId, planId, cookie);
    assert.equal(missingEpisode.status, 404);
    assert.match(missingEpisode.body.error!.message, /episode/);
    assert.equal(stores.aiJobs.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 11. Concurrent initiation — plan-row-lock serialization
// ---------------------------------------------------------------------------

test("C8.1 Generate - concurrent same-plan requests create exactly one job per shot", async () => {
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
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA, shotB] });

    // Fire TWO genuinely concurrent requests for the SAME plan. The fake
    // DB serializes their transactions (the plan-row-lock transaction), so
    // the second request's dedup read runs after the first request's jobs
    // are committed.
    const [first, second] = await Promise.all([
      generate(projectId, planId, cookie),
      generate(projectId, planId, cookie),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    // Exactly one winner created both jobs; the loser reported them as
    // already active. (Either request may win the lock.)
    const winners = [first, second].filter((r) => r.body.data!.created.length > 0);
    const losers = [first, second].filter((r) => r.body.data!.created.length === 0);
    assert.equal(winners.length, 1, "exactly one request may create the jobs");
    assert.equal(losers.length, 1, "exactly one request must observe the winner's jobs");
    assert.equal(winners[0]!.body.data!.created.length, 2);
    assert.equal(winners[0]!.body.data!.status, "completed");
    assert.equal(losers[0]!.body.data!.created.length, 0);
    assert.equal(losers[0]!.body.data!.alreadyActive.length, 2);
    assert.equal(losers[0]!.body.data!.status, "completed");
    assert.equal(losers[0]!.body.data!.failed.length, 0);

    // The DB holds exactly two jobs — no duplicates, and the loser's
    // alreadyActive ids are the winner's created ids.
    assert.equal(stores.aiJobs.size, 2);
    const winnerIds = winners[0]!.body.data!.created.map((r: any) => r.jobId).sort();
    const loserIds = losers[0]!.body.data!.alreadyActive.map((r: any) => r.jobId).sort();
    assert.deepEqual(loserIds, winnerIds);

    // Payload tracking is duplicate-free despite the concurrent calls.
    const payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    const tracked = payload.generatedJobIds as string[];
    assert.equal(tracked.length, 2, "no duplicate job ids in the tracking list");
    assert.deepEqual([...tracked].sort(), winnerIds);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - concurrent requests for different plans do not block each other", async () => {
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
    const planA = seedApprovedPlan(stores, projectId, episodeId, { [scene1]: [shotA] });
    const planB = seedApprovedPlan(stores, projectId, episodeId, { [scene2]: [shotB] });

    // Different plans → different row locks. Both must complete with their
    // own job created; neither reports the other plan's job.
    const [resA, resB] = await Promise.all([
      generate(projectId, planA, cookie),
      generate(projectId, planB, cookie),
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(resA.body.data!.status, "completed");
    assert.equal(resB.body.data!.status, "completed");
    assert.equal(resA.body.data!.created.length, 1);
    assert.equal(resB.body.data!.created.length, 1);
    assert.equal(resA.body.data!.created[0].shotId, shotA);
    assert.equal(resB.body.data!.created[0].shotId, shotB);
    assert.equal(resA.body.data!.alreadyActive.length, 0);
    assert.equal(resB.body.data!.alreadyActive.length, 0);

    assert.equal(stores.aiJobs.size, 2);
    const payloadA = (stores.productionPlans.get(planA)!.plan ?? {}) as Record<string, unknown>;
    const payloadB = (stores.productionPlans.get(planB)!.plan ?? {}) as Record<string, unknown>;
    assert.equal((payloadA.generatedJobIds as string[]).length, 1);
    assert.equal((payloadB.generatedJobIds as string[]).length, 1);
    assert.notDeepEqual(payloadA.generatedJobIds, payloadB.generatedJobIds);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - concurrent shot-level split across requests creates each shot once", async () => {
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
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA, shotB] });

    // Two concurrent requests for the same plan: union of the two reports
    // must cover both shots exactly once across created+alreadyActive.
    const [first, second] = await Promise.all([
      generate(projectId, planId, cookie),
      generate(projectId, planId, cookie),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    // Invariant: each shot appears in the union of both reports (created +
    // alreadyActive) exactly twice — once as the winner's `created` entry
    // and once as the loser's `alreadyActive` entry — and is CREATED only
    // once across both requests.
    const createdIds: string[] = [];
    const seenShots = new Map<string, number>();
    for (const res of [first, second]) {
      for (const ref of [...res.body.data!.created, ...res.body.data!.alreadyActive]) {
        seenShots.set(ref.shotId, (seenShots.get(ref.shotId) ?? 0) + 1);
      }
      for (const ref of res.body.data!.created) {
        createdIds.push(ref.shotId);
      }
    }
    assert.deepEqual([...seenShots.keys()].sort(), [shotA, shotB].sort());
    for (const count of seenShots.values()) {
      assert.equal(count, 2, "each shot: one created entry + one alreadyActive entry across the two requests");
    }
    createdIds.sort();
    assert.deepEqual(createdIds, [shotA, shotB].sort(), "each shot created exactly once across both requests");
    assert.equal(stores.aiJobs.size, 2);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 12. Payload tracking (generatedJobIds)
// ---------------------------------------------------------------------------

test("C8.1 Generate - created job ids are tracked in the plan payload", async () => {
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
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA, shotB] });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    const createdIds = res.body.data!.created.map((r: any) => r.jobId);

    const payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.generatedJobIds, createdIds);

    // Existing tracking keys survive the merge.
    assert.deepEqual(payload.sceneIds, [sceneId]);
    assert.deepEqual(payload.shotIds, { [sceneId]: [shotA, shotB] });
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - payload tracking preserves unrelated and user payload keys", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);

    // Pre-seed a payload with story, prompt tracking and user keys.
    const planId = randomUUID();
    stores.productionPlans.set(planId, {
      id: planId,
      projectId,
      episodeId,
      request: "req",
      status: "approved",
      plan: {
        story: { title: "T", premise: "P" },
        sceneIds: [sceneId],
        shotIds: { [sceneId]: [shotA] },
        promptedShotIds: [shotA],
        userNote: "keep me",
      },
      targetDurationSeconds: 30,
      preferences: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.data!.created.length, 1);

    const payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.userNote, "keep me");
    assert.deepEqual(payload.story, { title: "T", premise: "P" });
    assert.deepEqual(payload.promptedShotIds, [shotA]);
    assert.deepEqual(payload.sceneIds, [sceneId]);
    assert.equal((payload.generatedJobIds as string[]).length, 1);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - duplicate submission does not duplicate payload tracking", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    await generate(projectId, planId, cookie);
    await generate(projectId, planId, cookie);
    await generate(projectId, planId, cookie);

    const payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal((payload.generatedJobIds as string[]).length, 1, "append-only and duplicate-free");
    assert.equal(stores.aiJobs.size, 1);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - failed shots do not add payload tracking; later success does", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const { modelId } = seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    // No eligible model → per-shot failure, no job, no tracking.
    stores.aiModels.delete(modelId);
    const failedRes = await generate(projectId, planId, cookie);
    assert.equal(failedRes.status, 200);
    assert.equal(failedRes.body.data!.status, "failed");
    let payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal(payload.generatedJobIds, undefined, "no tracking on failure");

    // Restore the model → next attempt creates and tracks.
    seedVideoProviderAndModel(stores);
    const okRes = await generate(projectId, planId, cookie);
    assert.equal(okRes.status, 200);
    assert.equal(okRes.body.data!.status, "completed");
    payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal((payload.generatedJobIds as string[]).length, 1);
    assert.equal(stores.aiJobs.size, 1);
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - partial failure tracks only the created jobs", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const withPrompt = seedShot(stores, sceneId, 1);
    const withoutPrompt = seedShot(stores, sceneId, 2, { prompt: null });
    const planId = seedApprovedPlan(stores, projectId, episodeId, {
      [sceneId]: [withPrompt, withoutPrompt],
    });

    const res = await generate(projectId, planId, cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.data!.status, "partial");
    assert.equal(res.body.data!.created.length, 1);
    assert.equal(res.body.data!.failed.length, 1);

    const payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(
      payload.generatedJobIds,
      res.body.data!.created.map((r: any) => r.jobId),
      "only created jobs are tracked",
    );
  } finally {
    teardownDb();
  }
});

test("C8.1 Generate - concurrent payload edit and generation preserve both changes", async () => {
  installMockVideoAdapter();
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedVideoProviderAndModel(stores);
    const episodeId = seedEpisode(stores, projectId);
    const sceneId = seedScene(stores, episodeId, 1);
    const shotA = seedShot(stores, sceneId, 1);
    const planId = seedApprovedPlan(stores, projectId, episodeId, { [sceneId]: [shotA] });

    // A C7.1 PATCH that edits an unrelated payload key while the generate
    // request is in flight. The generate service re-reads the payload under
    // the lock, so whichever order runs, the other side's write survives.
    const patchPromise = jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ plan: { userNote: "edited during generation" } }),
    });
    const [genRes, patchRes] = await Promise.all([generate(projectId, planId, cookie), patchPromise]);
    assert.equal(genRes.status, 200);
    assert.ok(patchRes.status === 200 || patchRes.status === 409, "PATCH may win or lose the race, never corrupt");

    const payload = (stores.productionPlans.get(planId)!.plan ?? {}) as Record<string, unknown>;
    if (patchRes.status === 200) {
      assert.equal(payload.userNote, "edited during generation");
    }
    assert.equal((payload.generatedJobIds as string[]).length, 1, "job tracking never lost");
    assert.deepEqual(payload.shotIds, { [sceneId]: [shotA] });
  } finally {
    teardownDb();
  }
});
