// ---------------------------------------------------------------------------
// C7.1 — AI Production Director foundation (ProductionPlan)
//
// Covers creation, retrieval, listing, project-ownership enforcement,
// validation, lifecycle transitions, and — critically — proof that NO
// external provider/API call is ever made by the plan endpoints.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import {
  isValidPlanStatusTransition,
  ProductionPlanError,
} from "../src/services/production_plan.js";

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
    if (next && typeof next === "object" && Array.isArray(next.value) && next.value.join("") === " = ") {
      out.push({ column: columnName, value: after && "value" in after ? after.value : after });
      i += 2;
    }
  }
  return out;
}

function rowMatches(row: Record<string, unknown>, terms: Term[]): boolean {
  for (const t of terms) {
    const camel = t.column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const actual = t.column in row ? row[t.column] : row[camel];
    if (actual !== t.value) return false;
  }
  return true;
}

function makeFakeDb(stores: Stores) {
  function storeFor(table: unknown): Map<string, Record<string, unknown>> {
    const name = tableNameOf(table);
    if (name === "users") return stores.users;
    if (name === "sessions") return stores.sessions;
    if (name === "projects") return stores.projects;
    if (name === "episodes") return stores.episodes;
    if (name === "production_plans") return stores.productionPlans;
    throw new Error(`fake db: unknown table ${name}`);
  }

  return {
    select(projection?: Record<string, unknown>) {
      const from = (table: unknown) => {
        const store = storeFor(table);
        const all = () => Array.from(store.values()).map((r) => ({ ...r }));
        const filtered = (cond: unknown) => {
          const terms = walkPredicate(cond);
          return all().filter((r) => rowMatches(r, terms));
        };
        const tail = (rows: Array<Record<string, unknown>>) => ({
          orderBy: () => Promise.resolve(rows.map((r) => (projection ? projectRow(projection, r) : r))),
          then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(rows.map((r) => (projection ? projectRow(projection, r) : r))).then(resolve, reject),
        });
        return {
          where(cond: unknown) {
            return tail(filtered(cond));
          },
          orderBy: () => tail(all()),
          then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
            tail(all()).then(resolve, reject),
        };
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
              for (const row of store.values()) {
                if (rowMatches(row, terms)) Object.assign(row, vals);
              }
              return Promise.resolve({ affectedRows: 1 });
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
    __stores: stores,
  };
}

function projectRow(projection: Record<string, unknown>, row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(projection)) {
    out[key] = row[key];
  }
  return out;
}

interface Stores {
  users: Map<string, Record<string, unknown>>;
  sessions: Map<string, Record<string, unknown>>;
  projects: Map<string, Record<string, unknown>>;
  episodes: Map<string, Record<string, unknown>>;
  productionPlans: Map<string, Record<string, unknown>>;
}

function setupDb(): Stores {
  const stores: Stores = {
    users: new Map(),
    sessions: new Map(),
    projects: new Map(),
    episodes: new Map(),
    productionPlans: new Map(),
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

async function seedProject(stores: Stores, cookie: string, name = "Production Project"): Promise<string> {
  const res = await jsonRequest("/api/v1/projects", {
    method: "POST",
    cookie,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { data: any }).data.id;
}

async function createPlan(cookie: string, projectId: string, body: Record<string, unknown> = {}) {
  const res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans`, {
    method: "POST",
    cookie,
    body: JSON.stringify({
      request: "Make a 30-second Mozytoon episode about colors",
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

// ---------------------------------------------------------------------------
// 1-3. Create / retrieve / list
// ---------------------------------------------------------------------------

test("C7.1 Plans - create persists a local draft plan with planning defaults", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);

    const { status, body } = await createPlan(cookie, projectId, {
      preferences: { tone: "playful", audience: "kids" },
    });
    assert.equal(status, 201);
    const plan = body.data!;
    assert.equal(plan.projectId, projectId);
    assert.equal(plan.request, "Make a 30-second Mozytoon episode about colors");
    assert.equal(plan.status, "planning");
    assert.equal(plan.plan, null);
    assert.equal(plan.episodeId, null);
    assert.deepEqual(plan.preferences, { tone: "playful", audience: "kids" });
    assert.equal(plan.targetDurationSeconds, null);
    assert.equal(typeof plan.id, "string");
    assert.equal(typeof plan.createdAt, "string");
    assert.equal(typeof plan.updatedAt, "string");
    assert.equal(stores.productionPlans.size, 1);
  } finally {
    teardownDb();
  }
});

test("C7.1 Plans - plan can be retrieved by id within its project", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);

    const res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${created.body.data!.id}`, {
      cookie,
    });
    assert.equal(res.status, 200);
    const plan = ((await res.json()) as { data: any }).data;
    assert.equal(plan.id, created.body.data!.id);
    assert.equal(plan.status, "planning");
  } finally {
    teardownDb();
  }
});

test("C7.1 Plans - project plans are listed scoped to the project", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectA = await seedProject(stores, cookie, "Project A");
    const projectB = await seedProject(stores, cookie, "Project B");
    await createPlan(cookie, projectA, { request: "first" });
    await createPlan(cookie, projectA, { request: "second" });
    await createPlan(cookie, projectB, { request: "other project" });

    const res = await jsonRequest(`/api/v1/projects/${projectA}/production-plans`, { cookie });
    assert.equal(res.status, 200);
    const plans = ((await res.json()) as { data: any[] }).data;
    assert.equal(plans.length, 2, "only project A's plans are listed");
    assert.ok(plans.every((p) => p.projectId === projectA));
    const requests = plans.map((p) => p.request).sort();
    assert.deepEqual(requests, ["first", "second"]);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4-5. Ownership enforcement
// ---------------------------------------------------------------------------

test("C7.1 Plans - another user's project plan is invisible (404, not 403)", async () => {
  const stores = setupDb();
  try {
    const ownerCookie = await userSession(stores, "owner@example.com");
    const projectId = await seedProject(stores, ownerCookie);
    const created = await createPlan(ownerCookie, projectId);

    const otherCookie = await userSession(stores, "intruder@example.com");
    const planId = created.body.data!.id;

    // Read one
    const getRes = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      cookie: otherCookie,
    });
    assert.equal(getRes.status, 404);

    // List
    const listRes = await jsonRequest(`/api/v1/projects/${projectId}/production-plans`, {
      cookie: otherCookie,
    });
    assert.equal(listRes.status, 404);

    // Update
    const patchRes = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie: otherCookie,
      body: JSON.stringify({ status: "ready_for_review" }),
    });
    assert.equal(patchRes.status, 404);

    // The plan is untouched.
    assert.equal((stores.productionPlans.get(planId) as any).status, "planning");
  } finally {
    teardownDb();
  }
});

test("C7.1 Plans - nonexistent project and foreign episode are rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);

    // Nonexistent project
    const missing = await createPlan(cookie, randomUUID());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error!.message, "Project not found");

    // Episode anchored to a different project
    const projectA = await seedProject(stores, cookie, "A");
    const projectB = await seedProject(stores, cookie, "B");
    const episodeRes = await jsonRequest("/api/v1/episodes", {
      method: "POST",
      cookie,
      body: JSON.stringify({ projectId: projectB, title: "Ep 1", episodeNumber: 1 }),
    });
    assert.equal(episodeRes.status, 201);
    const episodeId = ((await episodeRes.json()) as { data: any }).data.id;

    const foreign = await createPlan(cookie, projectA, { episodeId });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error!.message, "Episode not found");

    // Correctly anchored episode is accepted.
    const ownEpisode = await jsonRequest("/api/v1/episodes", {
      method: "POST",
      cookie,
      body: JSON.stringify({ projectId: projectA, title: "Ep 1", episodeNumber: 1 }),
    });
    const ownEpisodeId = ((await ownEpisode.json()) as { data: any }).data.id;
    const anchored = await createPlan(cookie, projectA, { episodeId: ownEpisodeId });
    assert.equal(anchored.status, 201);
    assert.equal(anchored.body.data!.episodeId, ownEpisodeId);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Validation
// ---------------------------------------------------------------------------

test("C7.1 Plans - validation failures are 400 without creating records", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);

    // Empty request
    const empty = await createPlan(cookie, projectId, { request: "   " });
    assert.equal(empty.status, 400);

    // Missing request
    const missing = await jsonRequest(`/api/v1/projects/${projectId}/production-plans`, {
      method: "POST",
      cookie,
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    // Non-JSON body
    const malformed = await jsonRequest(`/api/v1/projects/${projectId}/production-plans`, {
      method: "POST",
      cookie,
      body: "not json at all",
    });
    assert.equal(malformed.status, 400);

    // Malformed episodeId (not 36 chars)
    const badEpisode = await createPlan(cookie, projectId, { episodeId: "too-short" });
    assert.equal(badEpisode.status, 400);

    assert.equal(stores.productionPlans.size, 0, "no plan may be created from invalid input");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7-8. State machine
// ---------------------------------------------------------------------------

test("C7.1 Plans - valid transitions and editable payload", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);
    const planId = created.body.data!.id;

    // Payload edit while planning
    let res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({
        plan: { scenes: [{ id: "s1", summary: "Primary colors" }], shots: [] },
        targetDurationSeconds: 30,
      }),
    });
    assert.equal(res.status, 200);
    let plan = ((await res.json()) as { data: any }).data;
    assert.deepEqual(plan.plan, { scenes: [{ id: "s1", summary: "Primary colors" }], shots: [] });
    assert.equal(plan.targetDurationSeconds, 30);
    assert.equal(plan.status, "planning", "payload edit alone does not change status");

    // planning → ready_for_review
    res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "ready_for_review" }),
    });
    assert.equal(res.status, 200);
    plan = ((await res.json()) as { data: any }).data;
    assert.equal(plan.status, "ready_for_review");

    // Edits in ready_for_review push it back to planning
    res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({
        plan: { scenes: [{ id: "s1", summary: "Revised" }], shots: [] },
        status: "planning",
      }),
    });
    assert.equal(res.status, 200);
    plan = ((await res.json()) as { data: any }).data;
    assert.equal(plan.status, "planning");
    assert.deepEqual(plan.plan, { scenes: [{ id: "s1", summary: "Revised" }], shots: [] });

    // ready_for_review → approved (terminal)
    res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "ready_for_review" }),
    });
    assert.equal(res.status, 200);
    res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(res.status, 200);
    plan = ((await res.json()) as { data: any }).data;
    assert.equal(plan.status, "approved");

    // Cancellation from planning is also valid
    const second = await createPlan(cookie, projectId);
    res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${second.body.data!.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "cancelled" }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { data: any }).data.status, "cancelled");
  } finally {
    teardownDb();
  }
});

test("C7.1 Plans - invalid transitions are rejected with 409", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);
    const planId = created.body.data!.id;

    // planning → approved directly is illegal (must pass ready_for_review)
    let res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(res.status, 409);

    // Move to approved properly, then verify terminal freezing.
    await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "ready_for_review" }),
    });
    await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "approved" }),
    });

    // approved → planning is illegal
    res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ status: "planning" }),
    });
    assert.equal(res.status, 409);

    // Payload edit while approved is illegal
    res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ plan: { tampered: true } }),
    });
    assert.equal(res.status, 409);
    assert.equal((stores.productionPlans.get(planId) as any).status, "approved");
    assert.equal((stores.productionPlans.get(planId) as any).plan, null);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 9. No external provider/API call
// ---------------------------------------------------------------------------

test("C7.1 Plans - no external provider/API call ever occurs (fetch tripwire)", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);

    // Tripwire: any attempt to reach the network fails the test loudly.
    let tripwireHits = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      tripwireHits += 1;
      throw new Error("TRIPWIRE: external network call attempted during plan lifecycle");
    }) as typeof fetch;

    try {
      const created = await createPlan(cookie, projectId, {
        episodeId: null,
        preferences: { tone: "playful" },
      });
      assert.equal(created.status, 201);
      const planId = created.body.data!.id;

      // Full lifecycle through the API: edit, review, approve.
      const edits = [
        { body: { plan: { scenes: [] }, targetDurationSeconds: 30 } },
        { body: { status: "ready_for_review" } },
        { body: { status: "approved" } },
      ];
      for (const edit of edits) {
        const res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
          method: "PATCH",
          cookie,
          body: JSON.stringify(edit.body),
        });
        assert.equal(res.status, 200);
      }

      // Reads are equally offline.
      const list = await jsonRequest(`/api/v1/projects/${projectId}/production-plans`, { cookie });
      assert.equal(list.status, 200);

      assert.equal(tripwireHits, 0, "no fetch call may be made during plan create/update/list");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// Unit: state machine invariants
// ---------------------------------------------------------------------------

test("C7.1 Plans - state machine allows self-transitions and forbids terminal exits", () => {
  assert.equal(isValidPlanStatusTransition("planning", "planning"), true);
  assert.equal(isValidPlanStatusTransition("planning", "ready_for_review"), true);
  assert.equal(isValidPlanStatusTransition("planning", "cancelled"), true);
  assert.equal(isValidPlanStatusTransition("planning", "failed"), true);
  assert.equal(isValidPlanStatusTransition("planning", "approved"), false);

  assert.equal(isValidPlanStatusTransition("ready_for_review", "planning"), true);
  assert.equal(isValidPlanStatusTransition("ready_for_review", "approved"), true);
  assert.equal(isValidPlanStatusTransition("ready_for_review", "cancelled"), true);

  for (const terminal of ["approved", "cancelled", "failed"] as const) {
    for (const status of ["planning", "ready_for_review", "approved", "cancelled", "failed"] as const) {
      assert.equal(
        isValidPlanStatusTransition(terminal, status),
        terminal === status,
        `terminal "${terminal}" must only self-transition`,
      );
    }
  }
});

test("C7.1 Plans - ProductionPlanError carries route-mappable statuses", () => {
  const notFound = new ProductionPlanError("Project not found", 404);
  assert.equal(notFound.status, 404);
  const conflict = new ProductionPlanError("Invalid transition", 409);
  assert.equal(conflict.status, 409);
});
