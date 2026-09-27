// ---------------------------------------------------------------------------
// C7.2 — Story AI Generation (ProductionPlan.plan.story)
//
// Synchronous planning-time story generation through the existing C6.8 text
// capability routing + the generic TextProvider abstraction. All providers
// here are deterministic in-process mocks — NO real OpenAI/Gemini/ChatFire
// call can ever happen (guarded by a global fetch tripwire).
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import { storyContractSchema, type StoryContract } from "@icooro/shared";
import {
  StoryGenerationError,
  extractJsonObject,
  parseStoryResponse,
} from "../src/services/story_generation.js";
import { buildStoryPrompt } from "../src/services/story_prompt.js";
import { registerAdapterFactory } from "../src/providers/factory.js";
import { ProviderError, type TextGenerationParams } from "../src/providers/types.js";

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

interface Stores {
  users: Map<string, Record<string, unknown>>;
  sessions: Map<string, Record<string, unknown>>;
  projects: Map<string, Record<string, unknown>>;
  episodes: Map<string, Record<string, unknown>>;
  productionPlans: Map<string, Record<string, unknown>>;
  aiProviders: Map<string, Record<string, unknown>>;
  aiModels: Map<string, Record<string, unknown>>;
}

function makeFakeDb(stores: Stores) {
  function storeFor(table: unknown): Map<string, Record<string, unknown>> {
    const name = tableNameOf(table);
    if (name === "users") return stores.users;
    if (name === "sessions") return stores.sessions;
    if (name === "projects") return stores.projects;
    if (name === "episodes") return stores.episodes;
    if (name === "production_plans") return stores.productionPlans;
    if (name === "ai_providers") return stores.aiProviders;
    if (name === "ai_models") return stores.aiModels;
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
        const tail = (rows: Array<Record<string, unknown>>) => {
          const projected = () => rows.map((r) => (projection ? projectRow(projection, r) : r));
          return {
            limit: () => tail(rows),
            orderBy: () => Promise.resolve(projected()),
            then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(projected()).then(resolve, reject),
          };
        };
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

function setupDb(): Stores {
  const stores: Stores = {
    users: new Map(),
    sessions: new Map(),
    projects: new Map(),
    episodes: new Map(),
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

// --- Deterministic mock text provider ---------------------------------------

interface MockTextAdapter {
  calls: TextGenerationParams[];
}

/**
 * Registers a deterministic mock text adapter under a fixed provider type so
 * the C6.8 capability routing resolves it from seeded ai_providers/ai_models
 * rows exactly like a real admin-configured provider. Every generateText
 * returns the fixed (or thrown) payload; every call is captured.
 */
function installMockTextAdapter(respond: () => string): MockTextAdapter {
  const calls: TextGenerationParams[] = [];
  registerAdapterFactory("mock-text", "Mock Text Provider", ["text"], () => ({
    providerType: "mock-text",
    name: "Mock Text Provider",
    capabilities: ["text"],
    testConnection: async () => ({ ok: true }),
    generateText: async (params: TextGenerationParams) => {
      calls.push({ ...params });
      return { text: respond() };
    },
  }));
  return { calls };
}

function seedTextProviderAndModel(stores: Stores): void {
  const providerId = randomUUID();
  stores.aiProviders.set(providerId, {
    id: providerId,
    name: "Mock Text Provider",
    providerType: "mock-text",
    enabled: true,
    baseUrl: null,
    apiKeySecret: null,
    config: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  stores.aiModels.set(`${providerId}:model`, {
    id: `${providerId}:model`,
    providerId,
    name: "Story model",
    modelId: "mock-story-model-1",
    capability: "text",
    jobTypes: null,
    enabled: true,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function validStory(overrides: Partial<StoryContract> = {}): StoryContract {
  return {
    title: "The Day Colors Went Missing",
    premise:
      "Mozy wakes to find every color in Toonville has vanished and must help bring them back.",
    learningObjective: "Viewers learn the primary colors and how mixing them makes new ones.",
    characters: ["Mozy", "Mimi", "Professor Palette"],
    setting: "Toonville on a gray morning",
    beginning: "Mozy discovers the world is gray and asks Mimi what happened to the colors.",
    middle: "The trio follows Professor Palette's clues, mixing paints to unlock the color vault.",
    ending: "The vault opens, colors flood back, and Mozy recites the primary colors.",
    estimatedDurationSeconds: 30,
    ...overrides,
  };
}

function validStoryText(overrides: Partial<StoryContract> = {}): string {
  return JSON.stringify(validStory(overrides));
}

// --- HTTP helpers -------------------------------------------------------------

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

async function seedProject(stores: Stores, cookie: string, name = "Story Project"): Promise<string> {
  const res = await jsonRequest("/api/v1/projects", {
    method: "POST",
    cookie,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { data: any }).data.id;
}

async function createPlan(
  cookie: string,
  projectId: string,
  body: Record<string, unknown> = {},
) {
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

async function generateStory(projectId: string, planId: string, cookie: string) {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/story`,
    { method: "POST", cookie },
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

async function patchPlan(
  cookie: string,
  projectId: string,
  planId: string,
  body: Record<string, unknown>,
) {
  const res = await jsonRequest(`/api/v1/projects/${projectId}/production-plans/${planId}`, {
    method: "PATCH",
    cookie,
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { data: any };
}

/** Full C7.2 scenario: owner, project, Mozytoon plan, routed mock text model. */
async function setupStoryScenario(respond: () => string) {
  const adapter = installMockTextAdapter(respond);
  const stores = setupDb();
  const cookie = await userSession(stores);
  const projectId = await seedProject(stores, cookie);
  const created = await createPlan(cookie, projectId, {
    targetDurationSeconds: 30,
    preferences: { audience: "kids", tone: "playful" },
  });
  assert.equal(created.status, 201);
  const planId = created.body.data!.id;
  // targetDurationSeconds is a plan-update field (not part of create), so set
  // it through the C7.1 PATCH route like a real user would.
  await patchPlan(cookie, projectId, planId, { targetDurationSeconds: 30 });
  seedTextProviderAndModel(stores);
  return { adapter, stores, cookie, projectId, planId };
}

/** Runs `fn` with a tripwire fetch that fails loudly on any network attempt. */
async function withFetchTripwire<T>(fn: () => Promise<T>): Promise<{ result: T; tripwireHits: number }> {
  let tripwireHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    tripwireHits += 1;
    throw new Error("TRIPWIRE: external network call attempted during story generation");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// 1. Success end-to-end (representative Mozytoon request)
// ---------------------------------------------------------------------------

test("C7.2 Story - successful generation persists the story under plan.story (Mozytoon request)", async () => {
  const { adapter, stores, cookie, projectId, planId } = await setupStoryScenario(() =>
    validStoryText(),
  );
  try {
    const { result, tripwireHits } = await withFetchTripwire(() =>
      generateStory(projectId, planId, cookie),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.error, undefined);

    // Validated story is returned and matches the shared contract.
    const story = result.body.data!.story;
    assert.equal(storyContractSchema.safeParse(story).success, true);
    assert.equal(story.title, "The Day Colors Went Missing");
    assert.deepEqual(story.characters, ["Mozy", "Mimi", "Professor Palette"]);
    assert.equal(story.estimatedDurationSeconds, 30);

    // Persisted under plan.story alongside the rest of the payload.
    const plan = result.body.data!.plan;
    assert.deepEqual(plan.story, story);

    // The generated request went through the generic provider exactly once,
    // addressed to the routed model, with the built prompts.
    assert.equal(adapter.calls.length, 1);
    const call = adapter.calls[0]!;
    assert.equal(call.modelId, "mock-story-model-1");
    assert.ok(call.prompt.includes("Make a 30-second Mozytoon episode about colors"));
    assert.ok(call.prompt.includes("30 seconds"));
    assert.ok(call.prompt.includes("audience"));
    assert.ok(call.systemPrompt.includes("JSON"));

    // The stored row carries the story and keeps its own fields.
    const row = stores.productionPlans.get(planId)!;
    assert.deepEqual(row.plan, plan);
    assert.equal(row.status, "planning");
    assert.equal(row.request, "Make a 30-second Mozytoon episode about colors");

    assert.equal(tripwireHits, 0, "no external network call may be made");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Persistence: unrelated plan fields preserved; regeneration story-only
// ---------------------------------------------------------------------------

test("C7.2 Story - unrelated plan payload fields survive generation", async () => {
  const { stores, cookie, projectId, planId } = await setupStoryScenario(() => validStoryText());
  try {
    await patchPlan(cookie, projectId, planId, {
      plan: { scenes: [{ id: "s1", summary: "Primary colors" }], notes: "keep me" },
    });

    const { status, body } = await generateStory(projectId, planId, cookie);
    assert.equal(status, 200);

    const plan = body.data!.plan;
    assert.deepEqual(plan.scenes, [{ id: "s1", summary: "Primary colors" }]);
    assert.equal(plan.notes, "keep me");
    assert.ok(plan.story, "story must be added to the payload");

    const row = stores.productionPlans.get(planId)!;
    assert.deepEqual(row.plan, plan);
  } finally {
    teardownDb();
  }
});

test("C7.2 Story - regeneration replaces only the story", async () => {
  const scenario = await setupStoryScenario(() => validStoryText());
  let { adapter } = scenario;
  const { stores, cookie, projectId, planId } = scenario;
  try {
    await patchPlan(cookie, projectId, planId, {
      plan: { scenes: [{ id: "s1", summary: "Primary colors" }], notes: "keep me" },
    });

    const first = await generateStory(projectId, planId, cookie);
    assert.equal(first.status, 200);
    const firstStory = first.body.data!.story;

    // Swap the deterministic response for a different (still valid) story.
    adapter = installMockTextAdapter(() =>
      validStoryText({
        title: "Mozy and the Mixed-Up Rainbow",
        premise: "A mixed-up rainbow sends Mozy hunting for the missing hues.",
      }),
    );

    const second = await generateStory(projectId, planId, cookie);
    assert.equal(second.status, 200);
    const secondStory = second.body.data!.story;

    assert.equal(secondStory.title, "Mozy and the Mixed-Up Rainbow");
    assert.notDeepEqual(secondStory, firstStory);

    const row = stores.productionPlans.get(planId)!;
    const plan = row.plan as Record<string, unknown>;
    assert.equal((plan.story as StoryContract).title, "Mozy and the Mixed-Up Rainbow");
    assert.deepEqual(plan.scenes, [{ id: "s1", summary: "Primary colors" }]);
    assert.equal(plan.notes, "keep me");
    assert.equal(row.status, "planning");
    assert.equal(row.request, "Make a 30-second Mozytoon episode about colors");
    assert.deepEqual(row.preferences, { audience: "kids", tone: "playful" });
    assert.equal(row.targetDurationSeconds, 30);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Failure modes: nothing is written, existing story survives
// ---------------------------------------------------------------------------

test("C7.2 Story - malformed JSON output fails with 502 and preserves the existing story", async () => {
  const scenario = await setupStoryScenario(() => validStoryText());
  let { adapter } = scenario;
  const { stores, cookie, projectId, planId } = scenario;
  try {
    const first = await generateStory(projectId, planId, cookie);
    assert.equal(first.status, 200);
    const preserved = (stores.productionPlans.get(planId)!.plan as Record<string, unknown>).story;

    adapter = installMockTextAdapter(() => "not json at all {{{");

    const failed = await generateStory(projectId, planId, cookie);
    assert.equal(failed.status, 502);
    assert.match(failed.body.error!.message, /valid JSON object/);

    const row = stores.productionPlans.get(planId)!;
    assert.deepEqual((row.plan as Record<string, unknown>).story, preserved);
    assert.equal(row.status, "planning");
    assert.deepEqual(adapter.calls.length, 1, "the failed attempt did reach the provider");
  } finally {
    teardownDb();
  }
});

test("C7.2 Story - schema-invalid output fails with 502 and preserves the existing story", async () => {
  const scenario = await setupStoryScenario(() => validStoryText());
  const { stores, cookie, projectId, planId } = scenario;
  try {
    const first = await generateStory(projectId, planId, cookie);
    assert.equal(first.status, 200);
    const preserved = (stores.productionPlans.get(planId)!.plan as Record<string, unknown>).story;

    // Valid JSON, but missing required keys and an invalid duration.
    installMockTextAdapter(() =>
      JSON.stringify({ title: "Half a story", estimatedDurationSeconds: 0 }),
    );

    const failed = await generateStory(projectId, planId, cookie);
    assert.equal(failed.status, 502);
    assert.match(failed.body.error!.message, /story structure/);

    const row = stores.productionPlans.get(planId)!;
    assert.deepEqual((row.plan as Record<string, unknown>).story, preserved);
    assert.equal(row.status, "planning");
  } finally {
    teardownDb();
  }
});

test("C7.2 Story - provider failure surfaces as 502 and preserves the existing story", async () => {
  const { stores, cookie, projectId, planId } = await setupStoryScenario(() => validStoryText());
  try {
    const first = await generateStory(projectId, planId, cookie);
    assert.equal(first.status, 200);
    const preserved = (stores.productionPlans.get(planId)!.plan as Record<string, unknown>).story;

    // Replace the mock with one that raises a provider-level failure.
    installMockTextAdapter(() => {
      throw new ProviderError("upstream rate limited", { provider: "mock-text", statusCode: 429 });
    });

    const failed = await generateStory(projectId, planId, cookie);
    assert.equal(failed.status, 502);
    assert.match(failed.body.error!.message, /Story generation failed/);
    assert.match(failed.body.error!.message, /rate limited/);

    const row = stores.productionPlans.get(planId)!;
    assert.deepEqual((row.plan as Record<string, unknown>).story, preserved);
    assert.equal(row.status, "planning");
  } finally {
    teardownDb();
  }
});

test("C7.2 Story - unexpected (non-ProviderError) failures are collapsed to a generic message", async () => {
  const { stores, cookie, projectId, planId } = await setupStoryScenario(() => validStoryText());
  try {
    installMockTextAdapter(() => {
      throw new Error("boom — leaked api key sk-abc123");
    });

    const { result, tripwireHits } = await withFetchTripwire(() =>
      generateStory(projectId, planId, cookie),
    );
    assert.equal(result.status, 502);
    assert.equal(
      result.body.error!.message,
      "Story generation failed due to an unexpected provider error.",
    );
    assert.ok(!JSON.stringify(result.body).includes("sk-abc123"), "no internal detail may leak");

    const row = stores.productionPlans.get(planId)!;
    assert.equal(row.plan, null, "nothing may be persisted on failure");
    assert.equal(tripwireHits, 0);
  } finally {
    teardownDb();
  }
});

test("C7.2 Story - no eligible text model/provider yields 400 without calling anything", async () => {
  const adapter = installMockTextAdapter(() => validStoryText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);
    assert.equal(created.status, 201);
    const planId = created.body.data!.id;
    // No ai_providers / ai_models rows seeded on purpose.

    const { status, body } = await generateStory(projectId, planId, cookie);
    assert.equal(status, 400);
    assert.match(body.error!.message, /No enabled text model/);
    assert.equal(adapter.calls.length, 0);

    const row = stores.productionPlans.get(planId)!;
    assert.equal(row.plan, null);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Ownership and state guards
// ---------------------------------------------------------------------------

test("C7.2 Story - another user's project is invisible (404, not 403)", async () => {
  const adapter = installMockTextAdapter(() => validStoryText());
  const stores = setupDb();
  try {
    const ownerCookie = await userSession(stores, "owner@example.com");
    const projectId = await seedProject(stores, ownerCookie);
    const created = await createPlan(ownerCookie, projectId);
    const planId = created.body.data!.id;
    seedTextProviderAndModel(stores);

    const otherCookie = await userSession(stores, "intruder@example.com");
    const { status, body } = await generateStory(projectId, planId, otherCookie);
    assert.equal(status, 404);
    assert.equal(body.error!.message, "Project not found");
    assert.equal(adapter.calls.length, 0);

    const row = stores.productionPlans.get(planId)!;
    assert.equal(row.plan, null);
  } finally {
    teardownDb();
  }
});

test("C7.2 Story - plan must belong to the requested project (404)", async () => {
  const adapter = installMockTextAdapter(() => validStoryText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectA = await seedProject(stores, cookie, "A");
    const projectB = await seedProject(stores, cookie, "B");
    const created = await createPlan(cookie, projectA);
    const planId = created.body.data!.id;
    seedTextProviderAndModel(stores);

    // Same owner, wrong project: the plan/project relationship fails.
    const wrongProject = await generateStory(projectB, planId, cookie);
    assert.equal(wrongProject.status, 404);
    assert.equal(wrongProject.body.error!.message, "Production plan not found");

    // Nonexistent plan id as well.
    const missing = await generateStory(projectA, randomUUID(), cookie);
    assert.equal(missing.status, 404);

    assert.equal(adapter.calls.length, 0);
    assert.ok(stores.productionPlans.get(planId)!.plan === null);
  } finally {
    teardownDb();
  }
});

test("C7.2 Story - only planning-state plans may generate stories (409)", async () => {
  const adapter = installMockTextAdapter(() => validStoryText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);
    const planId = created.body.data!.id;
    seedTextProviderAndModel(stores);

    // planning → ready_for_review, then generation must be refused.
    await patchPlan(cookie, projectId, planId, { status: "ready_for_review" });
    const inReview = await generateStory(projectId, planId, cookie);
    assert.equal(inReview.status, 409);
    assert.match(inReview.body.error!.message, /planning/);

    // ready_for_review → approved (terminal): still refused.
    await patchPlan(cookie, projectId, planId, { status: "approved" });
    const approved = await generateStory(projectId, planId, cookie);
    assert.equal(approved.status, 409);

    // Cancelled plans are likewise refused.
    const second = await createPlan(cookie, projectId);
    const secondId = second.body.data!.id;
    await patchPlan(cookie, projectId, secondId, { status: "cancelled" });
    const cancelled = await generateStory(projectId, secondId, cookie);
    assert.equal(cancelled.status, 409);

    assert.equal(adapter.calls.length, 0, "no provider call may happen outside planning");
    for (const id of [planId, secondId]) {
      const row = stores.productionPlans.get(id)!;
      assert.equal(row.plan, null);
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Unit: response parsing and prompt construction
// ---------------------------------------------------------------------------

test("C7.2 Story - extractJsonObject tolerates fences and prose but rejects non-objects", () => {
  const story = validStory();

  assert.deepEqual(extractJsonObject(JSON.stringify(story)), story);
  assert.deepEqual(
    extractJsonObject("```json\n" + JSON.stringify(story, null, 2) + "\n```"),
    story,
  );
  assert.deepEqual(
    extractJsonObject("Here is your story:\n" + JSON.stringify(story) + "\nHope it helps!"),
    story,
  );

  assert.throws(() => extractJsonObject("no json here"), StoryGenerationError);
  assert.throws(() => extractJsonObject("{ broken"), StoryGenerationError);
  assert.throws(() => extractJsonObject("[1, 2, 3]"), StoryGenerationError, "arrays are rejected");
  assert.throws(() => extractJsonObject("null"), StoryGenerationError);
});

test("C7.2 Story - parseStoryResponse validates against the shared contract and strips unknown keys", () => {
  const parsed = parseStoryResponse(
    JSON.stringify({ ...validStory(), weather: "sunny", extra: 42 }),
  );
  assert.deepEqual(parsed, validStory(), "unknown keys must not reach the plan payload");
  assert.equal("weather" in parsed, false);
  assert.equal("extra" in parsed, false);

  assert.throws(() => parseStoryResponse("{ not json"), StoryGenerationError);
  assert.throws(
    () => parseStoryResponse(JSON.stringify({ ...validStory(), ending: undefined })),
    StoryGenerationError,
    "missing required keys must fail validation",
  );
  assert.throws(
    () => parseStoryResponse(JSON.stringify({ ...validStory(), estimatedDurationSeconds: 7200 })),
    StoryGenerationError,
    "durations beyond the contract maximum must fail",
  );
  assert.throws(
    () => parseStoryResponse(JSON.stringify({ ...validStory(), title: 42 })),
    StoryGenerationError,
  );
});

test("C7.2 Story - buildStoryPrompt embeds request, duration, preferences and the contract", () => {
  const built = buildStoryPrompt({
    plan: {
      request: "Make a 30-second Mozytoon episode about colors",
      episodeId: null,
      targetDurationSeconds: 30,
      preferences: { audience: "kids" },
    },
    projectName: "Mozytoon Season 1",
  });

  assert.ok(built.userPrompt.includes("Make a 30-second Mozytoon episode about colors"));
  assert.ok(built.userPrompt.includes("30 seconds"));
  assert.ok(built.userPrompt.includes("audience"));
  for (const key of [
    "title",
    "premise",
    "learningObjective",
    "characters",
    "setting",
    "beginning",
    "middle",
    "ending",
    "estimatedDurationSeconds",
  ]) {
    assert.ok(built.userPrompt.includes(key), `contract key "${key}" must be requested`);
  }
  assert.ok(built.systemPrompt.toLowerCase().includes("json"));
});
