// ---------------------------------------------------------------------------
// C7.4 — AI Scene Generation (existing `scenes` table, plan.sceneIds refs)
//
// ProductionPlan → validated Story + Script → generic text provider →
// structured scene list → rows in the episode's EXISTING scenes table.
// All providers here are deterministic in-process mocks — NO real
// OpenAI/Gemini/ChatFire call can ever happen (guarded by a global fetch
// tripwire).
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import type { SceneListContract, ScriptContract, StoryContract } from "@icooro/shared";
import {
  SceneGenerationError,
  extractSceneJsonObject,
  parseSceneResponse,
} from "../src/services/scene_generation.js";
import { buildScenePrompt } from "../src/services/scene_prompt.js";
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
  scripts: Map<string, Record<string, unknown>>;
  scenes: Map<string, Record<string, unknown>>;
  shots: Map<string, Record<string, unknown>>;
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
    if (name === "scripts") return stores.scripts;
    if (name === "scenes") return stores.scenes;
    if (name === "shots") return stores.shots;
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
          let affected = 0;
          for (const [key, row] of Array.from(store.entries())) {
            if (rowMatches(row, terms)) {
              store.delete(key);
              affected += 1;
            }
          }
          return Promise.resolve({ affectedRows: affected });
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
    scripts: new Map(),
    scenes: new Map(),
    shots: new Map(),
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

interface SwitchableMockAdapter {
  calls: TextGenerationParams[];
  state: { respond: () => string };
}

function installSwitchableMockAdapter(): SwitchableMockAdapter {
  const calls: TextGenerationParams[] = [];
  const state: { respond: () => string } = { respond: () => "" };
  registerAdapterFactory("mock-text", "Mock Text Provider", ["text"], () => ({
    providerType: "mock-text",
    name: "Mock Text Provider",
    capabilities: ["text"],
    testConnection: async () => ({ ok: true }),
    generateText: async (params: TextGenerationParams) => {
      calls.push({ ...params });
      return { text: state.respond() };
    },
  }));
  return { calls, state };
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
    name: "Scene model",
    modelId: "mock-scene-model-1",
    capability: "text",
    jobTypes: null,
    enabled: true,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// --- Fixtures -----------------------------------------------------------------

const MOZYTOON_REQUEST = "Create a 30-second Mozytoon episode teaching children three basic colors.";

const MOZYTOON_STORY: StoryContract = {
  title: "The Day Colors Went Missing",
  premise: "Mozy wakes to find every color in Toonville has vanished and must help bring them back.",
  learningObjective: "Viewers learn the three primary colors: red, yellow, and blue.",
  characters: ["Mozy", "Mimi", "Professor Palette"],
  setting: "Toonville on a gray morning",
  beginning: "Mozy discovers the world is gray and asks Mimi what happened to the colors.",
  middle: "The trio follows Professor Palette's clues, finding the three primary colors.",
  ending: "The colors flood back and Mozy names red, yellow, and blue.",
  estimatedDurationSeconds: 30,
};

function validScript(overrides: Partial<ScriptContract> = {}): ScriptContract {
  return {
    title: "The Day Colors Went Missing",
    objective: "Viewers learn the three primary colors: red, yellow, and blue.",
    estimatedDurationSeconds: 30,
    dialogue: [
      { speaker: "Mozy", text: "Mimi, where did all the colors go?" },
      { speaker: "Mimi", text: "Look — Professor Palette has a clue!" },
      { speaker: "Professor Palette", text: "Red, yellow, and blue make every color shine." },
    ],
    closingLine: {
      speaker: "Mozy",
      text: "Red, yellow, and blue — the three colors that start it all!",
    },
    ...overrides,
  };
}

function validScriptText(overrides: Partial<ScriptContract> = {}): string {
  return JSON.stringify(validScript(overrides));
}

function validSceneList(): SceneListContract {
  return {
    scenes: [
      { name: "Gray Morning", description: "Mozy wakes to find Toonville drained of all color." },
      { name: "Palette's Clue", description: "Professor Palette reveals the first color clue." },
      { name: "Colors Return", description: "The trio restores red, yellow, and blue to Toonville." },
    ],
  };
}

function validSceneListText(): string {
  return JSON.stringify(validSceneList());
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

async function seedProject(stores: Stores, cookie: string, name = "Scene Project"): Promise<string> {
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
    body: JSON.stringify({ request: MOZYTOON_REQUEST, ...body }),
  });
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

async function generateScript(projectId: string, planId: string, cookie: string) {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/script`,
    { method: "POST", cookie },
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

async function callScenes(projectId: string, planId: string, cookie: string) {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/scenes`,
    { method: "POST", cookie },
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

// --- Row seeding helpers ------------------------------------------------------

function seedEpisode(stores: Stores, projectId: string, title: string, episodeNumber: number): string {
  const id = randomUUID();
  stores.episodes.set(id, {
    id,
    projectId,
    title,
    episodeNumber,
    status: "draft",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedScriptVersion(
  stores: Stores,
  episodeId: string,
  version: number,
  content: string,
): string {
  const id = randomUUID();
  stores.scripts.set(id, {
    id,
    episodeId,
    version,
    content,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedScene(
  stores: Stores,
  episodeId: string,
  name: string,
  description: string,
  orderIndex: number,
): string {
  const id = randomUUID();
  stores.scenes.set(id, {
    id,
    episodeId,
    name,
    description,
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
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function withFetchTripwire<T>(fn: () => Promise<T>): Promise<{ result: T; tripwireHits: number }> {
  let tripwireHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    tripwireHits += 1;
    throw new Error("TRIPWIRE: external network call attempted during scene generation");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- Scenario setup ------------------------------------------------------------

type SceneScenarioOptions = {
  initialRespond?: () => string;
  anchored?: boolean;
  extraPlanPayload?: Record<string, unknown>;
};

/** Plan with a story in its payload (what C7.2 leaves behind). */
async function setupSceneScenario(options: SceneScenarioOptions = {}) {
  const { calls, state } = installSwitchableMockAdapter();
  state.respond = options.initialRespond ?? (() => validSceneListText());
  const stores = setupDb();
  const cookie = await userSession(stores);
  const projectId = await seedProject(stores, cookie);
  const anchoredEpisodeId = options.anchored
    ? seedEpisode(stores, projectId, "Pilot episode", 1)
    : undefined;
  const created = await createPlan(cookie, projectId, {
    targetDurationSeconds: null,
    preferences: { audience: "kids", tone: "playful" },
    ...(anchoredEpisodeId ? { episodeId: anchoredEpisodeId } : {}),
  });
  assert.equal(created.status, 201);
  const planId = created.body.data!.id;
  await patchPlan(cookie, projectId, planId, {
    plan: { story: MOZYTOON_STORY, ...(options.extraPlanPayload ?? {}) },
  });
  seedTextProviderAndModel(stores);
  return { calls, state, stores, cookie, projectId, planId, anchoredEpisodeId };
}

/** Plan that has been through C7.3: story + episode + script version all real. */
async function setupSceneScenarioWithScript(options: SceneScenarioOptions = {}) {
  const ctx = await setupSceneScenario({ ...options, initialRespond: () => validScriptText() });
  const scriptRes = await generateScript(ctx.projectId, ctx.planId, ctx.cookie);
  assert.equal(scriptRes.status, 200);
  ctx.state.respond = options.initialRespond ?? (() => validSceneListText());
  const scriptData = (scriptRes.body as { data: any }).data!;
  return {
    ...ctx,
    episodeId: scriptData.episode.id as string,
    scriptVersionId: scriptData.scriptVersion.id as string,
  };
}

// ---------------------------------------------------------------------------
// 1. Successful generation — representative Mozytoon request (full pipeline)
// ---------------------------------------------------------------------------

test("C7.4 Scenes - successful generation persists the scene list (Mozytoon request)", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const { result, tripwireHits } = await withFetchTripwire(() =>
      callScenes(ctx.projectId, ctx.planId, ctx.cookie),
    );
    assert.equal(tripwireHits, 0, "no external network call may occur");
    assert.equal(result.status, 200);
    const data = result.body.data!;
    assert.equal(data.scenes.length, 3);
    assert.equal(data.scenes[0].name, "Gray Morning");
    assert.equal(data.scenes[2].description, "The trio restores red, yellow, and blue to Toonville.");
    assert.equal(data.scriptVersion.id, ctx.scriptVersionId);
    assert.equal(data.scriptVersion.version, 1);
    assert.equal(ctx.calls.length, 2); // once for script (C7.3), once for scenes
    assert.equal(ctx.calls[1].modelId, "mock-scene-model-1");
    assert.ok(typeof ctx.calls[1].systemPrompt === "string" && ctx.calls[1].systemPrompt.length > 0);
    // Persisted as ordinary rows in the existing scenes table.
    assert.equal(ctx.stores.scenes.size, 3);
    // Plan payload records only the references.
    const stored = ctx.stores.productionPlans.get(ctx.planId)!;
    const payload = stored.plan as Record<string, unknown>;
    assert.ok(Array.isArray(payload.sceneIds));
    assert.equal((payload.sceneIds as string[]).length, 3);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Correct episode association (anchored plan)
// ---------------------------------------------------------------------------

test("C7.4 Scenes - an anchored plan writes scenes onto its own episode", async () => {
  const ctx = await setupSceneScenarioWithScript({ anchored: true });
  try {
    assert.equal(ctx.episodeId, ctx.anchoredEpisodeId);
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 200);
    const data = res.body.data!;
    assert.equal(data.episode.id, ctx.anchoredEpisodeId);
    assert.equal(data.episode.projectId, ctx.projectId);
    for (const scene of data.scenes) {
      assert.equal(scene.episodeId, ctx.anchoredEpisodeId);
      const row = ctx.stores.scenes.get(scene.id)!;
      assert.equal(row.episodeId, ctx.anchoredEpisodeId);
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Sequential orderIndex assignment
// ---------------------------------------------------------------------------

test("C7.4 Scenes - generated scenes get sequential orderIndex values", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 200);
    const data = res.body.data!;
    assert.deepEqual(
      data.scenes.map((s: any) => s.orderIndex),
      [1, 2, 3],
    );
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Manual scenes preserved; generated scenes append after the current max
// ---------------------------------------------------------------------------

test("C7.4 Scenes - manual scenes are preserved and generated scenes append after the max orderIndex", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const manualId = seedScene(
      ctx.stores,
      ctx.episodeId,
      "Manual establishing shot",
      "Created by hand before any generation.",
      5,
    );
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 200);
    const data = res.body.data!;
    assert.deepEqual(
      data.scenes.map((s: any) => s.orderIndex),
      [6, 7, 8],
    );
    const manual = ctx.stores.scenes.get(manualId)!;
    assert.equal(manual.name, "Manual establishing shot");
    assert.equal(manual.orderIndex, 5);
    assert.equal(ctx.stores.scenes.size, 4);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Payload merge preserves story/episode/script refs and unrelated keys
// ---------------------------------------------------------------------------

test("C7.4 Scenes - payload merge preserves story, episodeId, scriptVersionId and unrelated keys", async () => {
  const ctx = await setupSceneScenarioWithScript({ extraPlanPayload: { userNote: "keep me" } });
  try {
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 200);
    const payload = res.body.data!.plan as Record<string, unknown>;
    assert.deepEqual(payload.story, MOZYTOON_STORY);
    assert.equal(payload.episodeId, ctx.episodeId);
    assert.equal(payload.scriptVersionId, ctx.scriptVersionId);
    assert.equal(payload.userNote, "keep me");
    assert.ok(Array.isArray(payload.sceneIds));
    const stored = ctx.stores.productionPlans.get(ctx.planId)!;
    assert.deepEqual(stored.plan, payload);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Successful regeneration replaces only tracked generated scenes
// ---------------------------------------------------------------------------

test("C7.4 Scenes - regeneration replaces only the tracked generated scenes", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const manualId = seedScene(ctx.stores, ctx.episodeId, "Manual scene", "By hand.", 1);
    const first = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(first.status, 200);
    const firstIds = first.body.data!.plan.sceneIds as string[];
    const firstNames = (first.body.data!.scenes as any[]).map((s) => s.name);

    ctx.state.respond = () =>
      JSON.stringify({
        scenes: [
          { name: "V2 Opening", description: "Regenerated opening scene." },
          { name: "V2 Finale", description: "Regenerated finale scene." },
        ],
      });
    const second = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 200);
    const secondData = second.body.data!;
    const secondIds = secondData.plan.sceneIds as string[];
    // Old tracked rows are gone; new ones exist; manual untouched.
    for (const id of firstIds) assert.equal(ctx.stores.scenes.has(id), false);
    for (const id of secondIds) assert.ok(ctx.stores.scenes.has(id));
    const manual = ctx.stores.scenes.get(manualId)!;
    assert.equal(manual.name, "Manual scene");
    assert.equal(manual.orderIndex, 1);
    assert.equal(ctx.stores.scenes.size, 3); // 1 manual + 2 regenerated
    assert.deepEqual(
      secondData.scenes.map((s: any) => s.orderIndex),
      [2, 3],
    );
    assert.deepEqual(secondData.scenes.map((s: any) => s.name), ["V2 Opening", "V2 Finale"]);
    assert.notDeepEqual(firstNames, ["V2 Opening", "V2 Finale"]);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7. Regeneration skips tracked scenes that were manually deleted
// ---------------------------------------------------------------------------

test("C7.4 Scenes - regeneration skips tracked scenes that were already deleted", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const manualId = seedScene(ctx.stores, ctx.episodeId, "Manual scene", "By hand.", 1);
    const first = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(first.status, 200);
    const firstIds = first.body.data!.plan.sceneIds as string[];
    // The user deletes one generated scene by hand.
    ctx.stores.scenes.delete(firstIds[0]!);

    const second = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 200);
    const secondIds = second.body.data!.plan.sceneIds as string[];
    assert.ok(!secondIds.includes(firstIds[0]!));
    for (const id of secondIds) assert.ok(ctx.stores.scenes.has(id));
    const manual = ctx.stores.scenes.get(manualId)!;
    assert.equal(manual.orderIndex, 1);
    // 1 manual + a full new set of 3 (the 2 surviving tracked scenes were
    // replaced, the deleted one was skipped).
    assert.equal(ctx.stores.scenes.size, 4);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8. Regeneration never deletes or modifies manual scenes
// ---------------------------------------------------------------------------

test("C7.4 Scenes - regeneration never deletes or modifies manual scenes", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const manualA = seedScene(ctx.stores, ctx.episodeId, "Manual A", "First manual.", 1);
    const manualB = seedScene(ctx.stores, ctx.episodeId, "Manual B", "Second manual.", 2);
    const beforeA = { ...ctx.stores.scenes.get(manualA)! };
    const beforeB = { ...ctx.stores.scenes.get(manualB)! };

    const first = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(first.status, 200);
    ctx.state.respond = () =>
      JSON.stringify({ scenes: [{ name: "Only One", description: "Single regenerated scene." }] });
    const second = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 200);

    const afterA = ctx.stores.scenes.get(manualA)!;
    const afterB = ctx.stores.scenes.get(manualB)!;
    assert.deepEqual(afterA, beforeA);
    assert.deepEqual(afterB, beforeB);
    assert.equal((second.body.data!.plan.sceneIds as string[]).length, 1);
    assert.equal(ctx.stores.scenes.size, 3); // 2 manual + 1 regenerated
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 9. Regeneration blocked with 409 when a tracked scene has shots
// ---------------------------------------------------------------------------

test("C7.4 Scenes - regeneration aborts with 409 when a tracked scene has shots; nothing changes", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const first = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(first.status, 200);
    const trackedIds = first.body.data!.plan.sceneIds as string[];
    const shotId = seedShot(ctx.stores, trackedIds[1]!, 1);
    const snapshot = new Map(
      Array.from(ctx.stores.scenes.entries()).map(([k, v]) => [k, { ...v }]),
    );

    ctx.state.respond = () => JSON.stringify({ scenes: [{ name: "X", description: "Y" }] });
    const second = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "CONFLICT");
    assert.match(second.body.error.message, /shots/i);
    // Scenes and shots remain exactly as they were; plan reference unchanged.
    assert.equal(ctx.stores.shots.has(shotId), true);
    assert.equal(ctx.stores.scenes.size, snapshot.size);
    for (const [id, row] of snapshot) assert.deepEqual(ctx.stores.scenes.get(id), row);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.sceneIds, trackedIds);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 9b. Concurrency safeguard (review M1): a shot added AFTER the pre-provider
// safety check but BEFORE deletion still aborts the regeneration with 409
// and no tracked scene is deleted (no partial replacement).
// ---------------------------------------------------------------------------

test("C7.4 Scenes - a shot added during generation aborts regeneration with 409 before any deletion", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const first = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(first.status, 200);
    const trackedIds = first.body.data!.plan.sceneIds as string[];

    // Simulate the race: the mock provider resolves only after a shot has
    // been added to the LAST tracked scene. The pre-provider check (which
    // scans in tracked order) sees nothing; the pre-delete re-check must.
    ctx.state.respond = () => {
      seedShot(ctx.stores, trackedIds[trackedIds.length - 1]!, 1);
      return JSON.stringify({ scenes: [{ name: "V2", description: "Regenerated scene." }] });
    };

    const snapshot = new Map(
      Array.from(ctx.stores.scenes.entries()).map(([k, v]) => [k, { ...v }]),
    );
    const second = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "CONFLICT");
    assert.match(second.body.error.message, /shots/i);
    // Every tracked scene survives (including the one that gained a shot),
    // the new shot is intact, and the plan reference is unchanged.
    for (const id of trackedIds) assert.ok(ctx.stores.scenes.has(id));
    assert.equal(ctx.stores.scenes.size, snapshot.size);
    for (const [id, row] of snapshot) assert.deepEqual(ctx.stores.scenes.get(id), row);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.sceneIds, trackedIds);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 10. Missing story → 400, no provider calls, no writes
// ---------------------------------------------------------------------------

test("C7.4 Scenes - missing story is a 400 and writes nothing", async () => {
  const ctx = await setupSceneScenario();
  try {
    // Replace the payload with a story-less one (as a user edit would).
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { userNote: "no story here" },
    });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_REQUEST");
    assert.match(res.body.error.message, /story/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 11. Missing/invalid episode relationship → 404
// ---------------------------------------------------------------------------

test("C7.4 Scenes - a plan with no episode is a 404", async () => {
  const ctx = await setupSceneScenario();
  try {
    // Remove the episode link from the payload (no anchored episode either).
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { plan: { story: MOZYTOON_STORY } });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.4 Scenes - an episode from another project is a 404", async () => {
  const ctx = await setupSceneScenario();
  try {
    const otherCookie = await userSession(ctx.stores, "other@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Other Project");
    const foreignEpisodeId = seedEpisode(ctx.stores, otherProjectId, "Foreign", 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId: foreignEpisodeId },
    });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 12. Missing script → 400, no provider calls, no writes
// ---------------------------------------------------------------------------

test("C7.4 Scenes - missing script is a 400 and writes nothing", async () => {
  const ctx = await setupSceneScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId },
    });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /script/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 13. Explicit script reference to a missing or wrong-episode script
// ---------------------------------------------------------------------------

test("C7.4 Scenes - an explicitly referenced missing script is a 404 without provider calls", async () => {
  const ctx = await setupSceneScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId, scriptVersionId: randomUUID() },
    });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /script version/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.4 Scenes - an explicitly referenced cross-episode script is a 404 without fallback", async () => {
  const ctx = await setupSceneScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const otherEpisodeId = seedEpisode(ctx.stores, ctx.projectId, "Other episode", 2);
    const foreignScriptId = seedScriptVersion(ctx.stores, otherEpisodeId, 1, validScriptText());
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId, scriptVersionId: foreignScriptId },
    });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 14. Corrupted / invalid stored script content → 400
// ---------------------------------------------------------------------------

test("C7.4 Scenes - corrupted stored script content is a 400 and writes nothing", async () => {
  const ctx = await setupSceneScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const scriptId = seedScriptVersion(ctx.stores, episodeId, 1, "this is not json at all");
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId, scriptVersionId: scriptId },
    });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /valid script/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.4 Scenes - schema-invalid stored script content is a 400 and writes nothing", async () => {
  const ctx = await setupSceneScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const scriptId = seedScriptVersion(
      ctx.stores,
      episodeId,
      1,
      JSON.stringify({ title: 42, dialogue: [] }),
    );
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId, scriptVersionId: scriptId },
    });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 15. Non-planning plan → 409
// ---------------------------------------------------------------------------

test("C7.4 Scenes - only planning-state plans may generate scenes (409)", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { status: "ready_for_review" });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONFLICT");
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 16. No eligible text model → 400 without generateText calls
// ---------------------------------------------------------------------------

test("C7.4 Scenes - no eligible text model yields 400 without generateText calls", async () => {
  const ctx = await setupSceneScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const scriptId = seedScriptVersion(ctx.stores, episodeId, 1, validScriptText());
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId, scriptVersionId: scriptId },
    });
    // No provider/model seeded for this store beyond the C7.3 pre-reqs —
    // remove them to simulate "no eligible text model".
    ctx.stores.aiProviders.clear();
    ctx.stores.aiModels.clear();
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /text model/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 17. Provider failure → sanitized 502, existing scenes preserved
// ---------------------------------------------------------------------------

test("C7.4 Scenes - provider failure surfaces as 502 and preserves existing scenes", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const manualId = seedScene(ctx.stores, ctx.episodeId, "Manual scene", "By hand.", 1);
    const first = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(first.status, 200);
    const trackedIds = first.body.data!.plan.sceneIds as string[];

    ctx.state.respond = () => {
      throw new ProviderError("upstream exploded", { provider: "mock-text" });
    };
    const second = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 502);
    assert.equal(second.body.error.code, "BAD_GATEWAY");
    assert.match(second.body.error.message, /Scene generation failed/);
    assert.match(second.body.error.message, /upstream exploded/);
    // Everything that existed before is untouched.
    assert.equal(ctx.stores.scenes.get(manualId)!.name, "Manual scene");
    for (const id of trackedIds) assert.ok(ctx.stores.scenes.has(id));
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.sceneIds, trackedIds);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 18. Non-ProviderError failures are sanitized
// ---------------------------------------------------------------------------

test("C7.4 Scenes - unexpected (non-ProviderError) failures are collapsed to a generic message", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    ctx.state.respond = () => {
      throw new Error("internal path /var/secret with credentials sk-abc123");
    };
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 502);
    assert.equal(
      res.body.error.message,
      "Scene generation failed due to an unexpected provider error.",
    );
    assert.ok(!res.body.error.message.includes("sk-abc123"));
    assert.ok(!res.body.error.message.includes("/var/secret"));
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 19. Malformed JSON → 502 without writes
// ---------------------------------------------------------------------------

test("C7.4 Scenes - malformed JSON output fails with 502 and writes nothing", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    ctx.state.respond = () => "Here are your scenes, unfortunately [[ broken";
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, "BAD_GATEWAY");
    assert.equal(ctx.calls.length, 2); // script + failed scene call
    assert.equal(ctx.stores.scenes.size, 0);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal(payload.sceneIds, undefined);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 20. Schema-invalid output → 502 without writes
// ---------------------------------------------------------------------------

test("C7.4 Scenes - schema-invalid outputs fail with 502 and write nothing", async () => {
  const invalidOutputs: string[] = [
    JSON.stringify({ scenes: [] }),
    JSON.stringify({ scenes: [{ description: "no name" }] }),
    JSON.stringify({ scenes: [{ name: "No description" }] }),
    JSON.stringify({ scenes: [{ name: " ".repeat(1), description: "blank name is invalid" }] }),
    JSON.stringify({ scenes: [{ name: "a".repeat(256), description: "name too long" }] }),
    JSON.stringify({ scenes: [{ name: "ok", description: "d".repeat(2001) }] }),
    JSON.stringify({
      scenes: Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, description: `Scene ${i}` })),
    }),
    JSON.stringify({ notScenes: true }),
  ];
  for (const [i, output] of invalidOutputs.entries()) {
    const ctx = await setupSceneScenarioWithScript();
    try {
      ctx.state.respond = () => output;
      const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
      assert.equal(res.status, 502, `case ${i} should be a 502`);
      assert.equal(ctx.stores.scenes.size, 0, `case ${i} must not write scenes`);
    } finally {
      teardownDb();
    }
  }
});

// ---------------------------------------------------------------------------
// 21. Unknown output keys are stripped before persistence
// ---------------------------------------------------------------------------

test("C7.4 Scenes - unknown AI-output keys are stripped by Zod before persistence", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    ctx.state.respond = () =>
      JSON.stringify({
        scenes: [
          {
            name: "Clean scene",
            description: "A scene with extra keys the contract does not allow.",
            shotList: [{ camera: "pan left" }],
            orderIndex: 99,
          },
        ],
        narrativeNotes: "ignore me",
      });
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 200);
    const scenes = res.body.data!.scenes as any[];
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0].name, "Clean scene");
    assert.equal(scenes[0].orderIndex, 1); // assigned by the service, not the AI
    const row = ctx.stores.scenes.get(scenes[0].id)!;
    assert.equal("shotList" in row, false);
    assert.equal("narrativeNotes" in row, false);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 22. Prompt unit test — context embedded, shots/camera/dialogue/media banned
// ---------------------------------------------------------------------------

test("C7.4 Scenes - buildScenePrompt embeds story/script/request and prohibits shot-layer content", () => {
  const built = buildScenePrompt({
    plan: {
      request: MOZYTOON_REQUEST,
      targetDurationSeconds: 30,
      preferences: { audience: "kids" },
    },
    story: MOZYTOON_STORY,
    script: validScript(),
    projectName: "Mozytoon",
  });

  assert.ok(built.userPrompt.includes(MOZYTOON_REQUEST));
  assert.ok(built.userPrompt.includes("Mozytoon"));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.title));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.learningObjective));
  assert.ok(built.userPrompt.includes(validScript().title));
  assert.ok(built.userPrompt.includes("Mimi, where did all the colors go?"));
  assert.ok(built.userPrompt.includes("Target duration: about 30 seconds"));
  assert.ok(built.userPrompt.includes(JSON.stringify({ audience: "kids" })));
  assert.ok(built.userPrompt.includes('"scenes"'));

  assert.ok(built.systemPrompt.includes("Do NOT include shots"));
  assert.ok(built.systemPrompt.includes("camera directions"));
  assert.ok(built.systemPrompt.includes("dialogue"));
  assert.ok(built.systemPrompt.includes("media-generation"));
  assert.ok(built.systemPrompt.includes("EXACTLY one JSON object"));
  assert.ok(built.systemPrompt.includes("Do NOT wrap the JSON in markdown code fences"));
  assert.ok(built.systemPrompt.includes("Do not add story or educational content"));
});

// ---------------------------------------------------------------------------
// 23. JSON extraction unit tests
// ---------------------------------------------------------------------------

test("C7.4 Scenes - extractSceneJsonObject tolerates fences and prose but rejects non-objects", () => {
  const object = { scenes: [{ name: "A", description: "B" }] };

  assert.deepEqual(extractSceneJsonObject(JSON.stringify(object)), object);
  assert.deepEqual(
    extractSceneJsonObject("```json\n" + JSON.stringify(object) + "\n```"),
    object,
  );
  assert.deepEqual(
    extractSceneJsonObject("Sure! Here are the scenes:\n" + JSON.stringify(object) + "\nHope that helps!"),
    object,
  );

  assert.throws(() => extractSceneJsonObject("not json at all"), (err: unknown) => {
    assert.ok(err instanceof SceneGenerationError);
    assert.equal((err as SceneGenerationError).status, 502);
    return true;
  });
  assert.throws(() => extractSceneJsonObject("[1, 2, 3]"), SceneGenerationError);
  assert.throws(() => extractSceneJsonObject('"just a string"'), SceneGenerationError);
  assert.throws(() => extractSceneJsonObject("42"), SceneGenerationError);
});

// ---------------------------------------------------------------------------
// 24. Repeated generation follows the tracked-scene replacement rules
// ---------------------------------------------------------------------------

test("C7.4 Scenes - repeated generation is consistent with tracked replacement", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const manualId = seedScene(ctx.stores, ctx.episodeId, "Manual scene", "By hand.", 1);
    const seenIdSets: string[][] = [];
    for (let round = 0; round < 3; round++) {
      const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
      assert.equal(res.status, 200);
      const ids = res.body.data!.plan.sceneIds as string[];
      assert.equal(ids.length, 3);
      seenIdSets.push(ids);
      // Manual scene always untouched; exactly 4 rows after every round.
      assert.equal(ctx.stores.scenes.get(manualId)!.name, "Manual scene");
      assert.equal(ctx.stores.scenes.size, 4);
      // Previous round's rows are gone.
      if (round > 0) {
        for (const id of seenIdSets[round - 1]!) assert.equal(ctx.stores.scenes.has(id), false);
      }
      // orderIndex always continues right after the manual scene.
      assert.deepEqual(
        (res.body.data!.scenes as any[]).map((s) => s.orderIndex),
        [2, 3, 4],
      );
    }
    for (let i = 0; i < seenIdSets.length; i++) {
      for (let j = i + 1; j < seenIdSets.length; j++) {
        assert.ok(!seenIdSets[i]!.some((id) => seenIdSets[j]!.includes(id)));
      }
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// Extra: parseSceneResponse contract edges (unit)
// ---------------------------------------------------------------------------

test("C7.4 Scenes - parseSceneResponse validates the contract and strips unknown keys", () => {
  const valid = parseSceneResponse(
    JSON.stringify({
      scenes: [{ name: "A", description: "B", extra: "stripped" }],
      trailer: "stripped",
    }),
  );
  assert.deepEqual(valid, { scenes: [{ name: "A", description: "B" }] });

  assert.throws(() => parseSceneResponse("{ broken"), SceneGenerationError);
  assert.throws(() => parseSceneResponse(JSON.stringify({ scenes: [] })), SceneGenerationError);
  assert.throws(
    () => parseSceneResponse(JSON.stringify({ scenes: [{ name: "A" }] })),
    SceneGenerationError,
  );
});

// ---------------------------------------------------------------------------
// Extra: cross-project plan access stays invisible (404, not 403)
// ---------------------------------------------------------------------------

test("C7.4 Scenes - another user's project is invisible (404, not 403)", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const otherCookie = await userSession(ctx.stores, "intruder@example.com");
    const res = await callScenes(ctx.projectId, ctx.planId, otherCookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// Extra: plan from another project cannot be used through its own project
// ---------------------------------------------------------------------------

test("C7.4 Scenes - plan must belong to the requested project (404)", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    const otherCookie = await userSession(ctx.stores, "second@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Second Project");
    const res = await callScenes(otherProjectId, ctx.planId, otherCookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// Extra: scenes land on the episode created by C7.3 for unanchored plans
// ---------------------------------------------------------------------------

test("C7.4 Scenes - unanchored plans use the episode recorded by script generation", async () => {
  const ctx = await setupSceneScenarioWithScript();
  try {
    assert.notEqual(ctx.episodeId, ctx.anchoredEpisodeId ?? null);
    const res = await callScenes(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.data!.episode.id, ctx.episodeId);
    const rows = Array.from(ctx.stores.scenes.values());
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(row.episodeId, ctx.episodeId);
  } finally {
    teardownDb();
  }
});
