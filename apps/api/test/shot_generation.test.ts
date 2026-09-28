// ---------------------------------------------------------------------------
// C7.5 — AI Shot Generation (existing `shots` table, plan.shotIds refs)
//
// ProductionPlan → validated Story + Script + Scene → generic text provider →
// structured shot list → rows in the scene's EXISTING shots table. All
// providers here are deterministic in-process mocks — NO real
// OpenAI/Gemini/ChatFire call can ever happen (guarded by a global fetch
// tripwire). `shot_versions` is NEVER written: it stays media history.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import type { ShotListContract, ScriptContract, StoryContract } from "@icooro/shared";
import {
  ShotGenerationError,
  extractShotJsonObject,
  parseShotResponse,
} from "../src/services/shot_generation.js";
import { buildShotPrompt } from "../src/services/shot_prompt.js";
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
  shotVersions: Map<string, Record<string, unknown>>;
  shotCharacters: Map<string, Record<string, unknown>>;
  shotLocations: Map<string, Record<string, unknown>>;
  shotProps: Map<string, Record<string, unknown>>;
  shotAssets: Map<string, Record<string, unknown>>;
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
    if (name === "shot_versions") return stores.shotVersions;
    if (name === "shot_characters") return stores.shotCharacters;
    if (name === "shot_locations") return stores.shotLocations;
    if (name === "shot_props") return stores.shotProps;
    if (name === "shot_assets") return stores.shotAssets;
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
    shotVersions: new Map(),
    shotCharacters: new Map(),
    shotLocations: new Map(),
    shotProps: new Map(),
    shotAssets: new Map(),
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
    name: "Shot model",
    modelId: "mock-shot-model-1",
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

function validSceneListText(): string {
  return JSON.stringify({
    scenes: [
      { name: "Gray Morning", description: "Mozy wakes to find Toonville drained of all color." },
      { name: "Palette's Clue", description: "Professor Palette reveals the first color clue." },
      { name: "Colors Return", description: "The trio restores red, yellow, and blue to Toonville." },
    ],
  });
}

function validShotList(): ShotListContract {
  return {
    shots: [
      {
        purpose: "Establish the colorless town",
        shotType: "wide",
        framing: "full shot",
        cameraMovement: "slow pan",
        cameraAngle: "eye level",
        actionDescription: "Mozy looks out over the gray streets of Toonville.",
        visualDescription: "A desaturated town; Mozy small against the skyline.",
        transition: "cut to",
        duration: 8,
      },
      {
        purpose: "Show Mozy's discovery",
        shotType: "medium",
        framing: "single",
        cameraMovement: "static",
        cameraAngle: "eye level",
        actionDescription: "Mozy touches a flower that stays gray.",
        visualDescription: "Close foreground of the gray flower in Mozy's hand.",
        transition: "cut to",
        duration: 7,
      },
      {
        purpose: "End the scene on the question",
        shotType: "close-up",
        framing: "single",
        cameraMovement: "push in",
        cameraAngle: "low angle",
        actionDescription: "Mozy asks where all the colors went.",
        visualDescription: "Mozy's puzzled face fills the frame.",
        transition: "cut to",
        duration: 5,
      },
    ],
  };
}

function validShotListText(): string {
  return JSON.stringify(validShotList());
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

async function seedProject(stores: Stores, cookie: string, name = "Shot Project"): Promise<string> {
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

async function callShots(
  projectId: string,
  planId: string,
  sceneId: string,
  cookie: string,
) {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/scenes/${sceneId}/shots`,
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
  description: string | null,
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

function seedShot(stores: Stores, sceneId: string, name: string, orderIndex: number): string {
  const id = randomUUID();
  stores.shots.set(id, {
    id,
    sceneId,
    orderIndex,
    purpose: name,
    shotType: "wide",
    framing: "full shot",
    cameraMovement: "static",
    cameraAngle: "eye level",
    prompt: null,
    visualDescription: "seeded manual shot",
    actionDescription: "seeded manual shot",
    dialogue: null,
    transition: "cut to",
    productionNotes: null,
    duration: 4,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedShotVersion(stores: Stores, shotId: string): string {
  const id = randomUUID();
  stores.shotVersions.set(id, {
    id,
    shotId,
    version: 1,
    prompt: null,
    status: "completed",
    providerId: null,
    modelId: null,
    assetId: null,
    duration: 4,
    error: null,
    productionReady: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

type LinkKind = "shotCharacters" | "shotLocations" | "shotProps" | "shotAssets";

function seedShotLink(stores: Stores, kind: LinkKind, shotId: string, entityId: string): string {
  const id = randomUUID();
  const idField =
    kind === "shotCharacters" ? "characterId"
    : kind === "shotLocations" ? "locationId"
    : kind === "shotProps" ? "propId"
    : "assetId";
  stores[kind].set(id, {
    id,
    shotId,
    [idField]: entityId,
    ...(kind === "shotAssets" ? { assetRole: "reference" } : {}),
    createdAt: new Date(),
  });
  return id;
}

async function withFetchTripwire<T>(fn: () => Promise<T>): Promise<{ result: T; tripwireHits: number }> {
  let tripwireHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    tripwireHits += 1;
    throw new Error("TRIPWIRE: external network call attempted during shot generation");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- Scenario setup ------------------------------------------------------------

type ShotScenarioOptions = {
  anchored?: boolean;
  extraPlanPayload?: Record<string, unknown>;
};

/** Plan with a story in its payload (what C7.2 leaves behind). */
async function setupShotScenario(options: ShotScenarioOptions = {}) {
  const { calls, state } = installSwitchableMockAdapter();
  state.respond = () => validScriptText();
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

/** Plan that has been through C7.3 (real script + episode) and a seeded target scene. */
async function setupShotScenarioWithScene(options: ShotScenarioOptions = {}) {
  const ctx = await setupShotScenario(options);
  const scriptRes = await generateScript(ctx.projectId, ctx.planId, ctx.cookie);
  assert.equal(scriptRes.status, 200);
  ctx.state.respond = () => validShotListText();
  const scriptData = (scriptRes.body as { data: any }).data!;
  const episodeId = scriptData.episode.id as string;
  const sceneId = seedScene(
    ctx.stores,
    episodeId,
    "Gray Morning",
    "Mozy wakes to find Toonville drained of all color.",
    1,
  );
  return {
    ...ctx,
    episodeId,
    scriptVersionId: scriptData.scriptVersion.id as string,
    sceneId,
  };
}

// ---------------------------------------------------------------------------
// 1. Successful generation — representative Mozytoon request (full pipeline)
// ---------------------------------------------------------------------------

test("C7.5 Shots - successful generation persists the shot list (Mozytoon request)", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const { result, tripwireHits } = await withFetchTripwire(() =>
      callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie),
    );
    assert.equal(tripwireHits, 0, "no external network call may occur");
    assert.equal(result.status, 200);
    const data = result.body.data!;
    assert.equal(data.shots.length, 3);
    assert.equal(data.shots[0].purpose, "Establish the colorless town");
    assert.equal(data.shots[2].duration, 5);
    assert.equal(data.scene.id, ctx.sceneId);
    assert.equal(data.scriptVersion.id, ctx.scriptVersionId);
    assert.equal(ctx.calls.length, 2); // once for script (C7.3), once for shots
    assert.equal(ctx.calls[1].modelId, "mock-shot-model-1");
    assert.ok(typeof ctx.calls[1].systemPrompt === "string" && ctx.calls[1].systemPrompt.length > 0);
    // Persisted as ordinary rows in the existing shots table.
    assert.equal(ctx.stores.shots.size, 3);
    const firstRow = data.shots[0] ? ctx.stores.shots.get(data.shots[0].id) : undefined;
    assert.equal(firstRow?.sceneId, ctx.sceneId);
    assert.equal(firstRow?.shotType, "wide");
    assert.equal(firstRow?.status, "pending");
    // The service never writes a media prompt; real MySQL would leave the
    // column at its NULL default (the fake DB stores only written keys).
    assert.equal(firstRow?.prompt ?? null, null); // media prompt stays untouched
    // Plan payload records only the scene-keyed references.
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    const shotIds = payload.shotIds as Record<string, unknown> | undefined;
    assert.ok(shotIds && Array.isArray(shotIds[ctx.sceneId]));
    assert.equal((shotIds[ctx.sceneId] as string[]).length, 3);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2 + 3. Scene association and sequential orderIndex
// ---------------------------------------------------------------------------

test("C7.5 Shots - shots land on the target scene with sequential orderIndex", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 200);
    const data = res.body.data!;
    assert.deepEqual(
      data.shots.map((s: any) => s.orderIndex),
      [1, 2, 3],
    );
    for (const shot of data.shots) {
      assert.equal(shot.sceneId, ctx.sceneId);
      assert.equal(ctx.stores.shots.get(shot.id)!.sceneId, ctx.sceneId);
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Manual shots preserved; generated shots append after the max orderIndex
// ---------------------------------------------------------------------------

test("C7.5 Shots - manual shots are preserved and generated shots append after the max orderIndex", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const manualId = seedShot(ctx.stores, ctx.sceneId, "Manual establishing", 5);
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 200);
    const data = res.body.data!;
    assert.deepEqual(
      data.shots.map((s: any) => s.orderIndex),
      [6, 7, 8],
    );
    const manual = ctx.stores.shots.get(manualId)!;
    assert.equal(manual.purpose, "Manual establishing");
    assert.equal(manual.orderIndex, 5);
    assert.equal(ctx.stores.shots.size, 4);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Payload merge preserves story/episode/script/scene refs and user keys
// ---------------------------------------------------------------------------

test("C7.5 Shots - payload merge preserves story, episodeId, scriptVersionId, sceneIds and unrelated keys", async () => {
  const ctx = await setupShotScenarioWithScene({
    extraPlanPayload: { userNote: "keep me", sceneIds: ["pre-existing-scene-id"] },
  });
  try {
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 200);
    const payload = res.body.data!.plan as Record<string, unknown>;
    assert.deepEqual(payload.story, MOZYTOON_STORY);
    assert.equal(payload.episodeId, ctx.episodeId);
    assert.equal(payload.scriptVersionId, ctx.scriptVersionId);
    assert.deepEqual(payload.sceneIds, ["pre-existing-scene-id"]);
    assert.equal(payload.userNote, "keep me");
    const shotIds = payload.shotIds as Record<string, string[]>;
    assert.deepEqual(shotIds[ctx.sceneId]!.length, 3);
    const stored = ctx.stores.productionPlans.get(ctx.planId)!;
    assert.deepEqual(stored.plan, payload);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Successful regeneration replaces only tracked shots of the target scene
// ---------------------------------------------------------------------------

test("C7.5 Shots - regeneration replaces only the tracked shots of the target scene", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const manualId = seedShot(ctx.stores, ctx.sceneId, "Manual shot", 1);
    const first = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(first.status, 200);
    const firstIds = (first.body.data!.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;

    ctx.state.respond = () =>
      JSON.stringify({
        shots: [
          {
            purpose: "V2 only",
            shotType: "wide",
            framing: "full shot",
            cameraMovement: "static",
            cameraAngle: "eye level",
            actionDescription: "Regenerated shot.",
            visualDescription: "Regenerated shot.",
            transition: "cut to",
            duration: 6,
          },
        ],
      });
    const second = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(second.status, 200);
    const secondData = second.body.data!;
    const secondIds = (secondData.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;
    for (const id of firstIds) assert.equal(ctx.stores.shots.has(id), false);
    for (const id of secondIds) assert.ok(ctx.stores.shots.has(id));
    const manual = ctx.stores.shots.get(manualId)!;
    assert.equal(manual.purpose, "Manual shot");
    assert.equal(manual.orderIndex, 1);
    assert.equal(ctx.stores.shots.size, 2); // 1 manual + 1 regenerated
    assert.deepEqual(
      secondData.shots.map((s: any) => s.orderIndex),
      [2],
    );
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7. Regeneration skips tracked shots that were deleted or moved
// ---------------------------------------------------------------------------

test("C7.5 Shots - regeneration skips tracked shots that were deleted or moved", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const first = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(first.status, 200);
    const firstIds = (first.body.data!.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;
    // One shot is deleted by hand; another is "moved" by re-scoping its row.
    ctx.stores.shots.delete(firstIds[0]!);
    ctx.stores.shots.set(firstIds[1]!, { ...ctx.stores.shots.get(firstIds[1]!)!, sceneId: randomUUID() });

    const second = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(second.status, 200);
    const secondIds = (second.body.data!.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;
    assert.equal(secondIds.length, 3);
    for (const id of secondIds) assert.ok(ctx.stores.shots.has(id));
    // The moved shot is still there, untouched, on its new scene.
    assert.ok(ctx.stores.shots.has(firstIds[1]!));
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8. Regeneration never deletes or modifies manual shots
// ---------------------------------------------------------------------------

test("C7.5 Shots - regeneration never deletes or modifies manual shots", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const manualA = seedShot(ctx.stores, ctx.sceneId, "Manual A", 1);
    const manualB = seedShot(ctx.stores, ctx.sceneId, "Manual B", 2);
    const beforeA = { ...ctx.stores.shots.get(manualA)! };
    const beforeB = { ...ctx.stores.shots.get(manualB)! };

    const first = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(first.status, 200);
    const second = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(second.status, 200);

    assert.deepEqual(ctx.stores.shots.get(manualA)!, beforeA);
    assert.deepEqual(ctx.stores.shots.get(manualB)!, beforeB);
    assert.equal(ctx.stores.shots.size, 5); // 2 manual + 3 regenerated
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 9. Dependent-data conflicts: each table blocks regeneration with 409
// ---------------------------------------------------------------------------

const DEPENDENT_KINDS: Array<{ label: string; seed: (stores: Stores, shotId: string) => string }> = [
  { label: "shot versions", seed: (s, id) => seedShotVersion(s, id) },
  { label: "shot characters", seed: (s, id) => seedShotLink(s, "shotCharacters", id, randomUUID()) },
  { label: "shot locations", seed: (s, id) => seedShotLink(s, "shotLocations", id, randomUUID()) },
  { label: "shot props", seed: (s, id) => seedShotLink(s, "shotProps", id, randomUUID()) },
  { label: "shot assets", seed: (s, id) => seedShotLink(s, "shotAssets", id, randomUUID()) },
];

for (const kind of DEPENDENT_KINDS) {
  test(`C7.5 Shots - tracked shot with ${kind.label} blocks regeneration (409)`, async () => {
    const ctx = await setupShotScenarioWithScene();
    try {
      const first = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
      assert.equal(first.status, 200);
      const trackedIds = (first.body.data!.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;
      const dependentId = kind.seed(ctx.stores, trackedIds[1]!);
      const snapshot = new Map(
        Array.from(ctx.stores.shots.entries()).map(([k, v]) => [k, { ...v }]),
      );

      const second = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
      assert.match(second.body.error.message, /dependent data/i);
      // Shots and dependent rows remain exactly as they were.
      assert.equal(ctx.stores.shots.size, snapshot.size);
      for (const [id, row] of snapshot) assert.deepEqual(ctx.stores.shots.get(id), row);
      const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
      assert.deepEqual((payload.shotIds as Record<string, string[]>)[ctx.sceneId], trackedIds);
      // The dependent row still exists (spot check via its store).
      const store = kind.label === "shot versions"
        ? ctx.stores.shotVersions
        : kind.label === "shot characters"
          ? ctx.stores.shotCharacters
          : kind.label === "shot locations"
            ? ctx.stores.shotLocations
            : kind.label === "shot props"
              ? ctx.stores.shotProps
              : ctx.stores.shotAssets;
      assert.ok(store.has(dependentId));
    } finally {
      teardownDb();
    }
  });
}

// ---------------------------------------------------------------------------
// 9b. Race: dependency added DURING generation aborts before any deletion
// ---------------------------------------------------------------------------

test("C7.5 Shots - a dependency added during generation aborts with 409 before any deletion", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const first = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(first.status, 200);
    const trackedIds = (first.body.data!.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;

    // The pre-provider check scans in tracked order and sees nothing; the
    // respond function adds a shot version to the LAST tracked shot, so
    // only the pre-delete re-check can catch it.
    ctx.state.respond = () => {
      seedShotVersion(ctx.stores, trackedIds[trackedIds.length - 1]!);
      return validShotListText();
    };

    const snapshot = new Map(
      Array.from(ctx.stores.shots.entries()).map(([k, v]) => [k, { ...v }]),
    );
    const second = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(second.status, 409);
    assert.match(second.body.error.message, /dependent data/i);
    for (const id of trackedIds) assert.ok(ctx.stores.shots.has(id));
    assert.equal(ctx.stores.shots.size, snapshot.size);
    for (const [id, row] of snapshot) assert.deepEqual(ctx.stores.shots.get(id), row);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual((payload.shotIds as Record<string, string[]>)[ctx.sceneId], trackedIds);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 10. Missing story → 400, no provider calls, no writes
// ---------------------------------------------------------------------------

test("C7.5 Shots - missing story is a 400 and writes nothing", async () => {
  const ctx = await setupShotScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const sceneId = seedScene(ctx.stores, episodeId, "S", "D", 1);
    seedScriptVersion(ctx.stores, episodeId, 1, validScriptText());
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { userNote: "no story here", episodeId },
    });
    const res = await callShots(ctx.projectId, ctx.planId, sceneId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /story/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 11. Episode/scene relationship failures → 404
// ---------------------------------------------------------------------------

test("C7.5 Shots - a plan with no episode is a 404", async () => {
  const ctx = await setupShotScenario();
  try {
    const foreignEpisode = seedEpisode(ctx.stores, randomUUID(), "Nowhere", 1);
    const sceneId = seedScene(ctx.stores, foreignEpisode, "S", "D", 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { plan: { story: MOZYTOON_STORY } });
    const res = await callShots(ctx.projectId, ctx.planId, sceneId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.5 Shots - an episode from another project is a 404", async () => {
  const ctx = await setupShotScenario();
  try {
    const otherCookie = await userSession(ctx.stores, "other@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Other Project");
    const foreignEpisodeId = seedEpisode(ctx.stores, otherProjectId, "Foreign", 1);
    const sceneId = seedScene(ctx.stores, foreignEpisodeId, "S", "D", 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId: foreignEpisodeId },
    });
    const res = await callShots(ctx.projectId, ctx.planId, sceneId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.5 Shots - a scene of another episode in the same project is a 404", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const otherEpisodeId = seedEpisode(ctx.stores, ctx.projectId, "Episode 2", 2);
    const foreignSceneId = seedScene(ctx.stores, otherEpisodeId, "Foreign scene", "D", 1);
    const res = await callShots(ctx.projectId, ctx.planId, foreignSceneId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /scene/i);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.5 Shots - a scene of another project is a 404", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const otherCookie = await userSession(ctx.stores, "third@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Third Project");
    const foreignEpisodeId = seedEpisode(ctx.stores, otherProjectId, "Foreign", 1);
    const foreignSceneId = seedScene(ctx.stores, foreignEpisodeId, "S", "D", 1);
    const res = await callShots(ctx.projectId, ctx.planId, foreignSceneId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 12. Script prerequisite failures
// ---------------------------------------------------------------------------

test("C7.5 Shots - missing script is a 400 and writes nothing", async () => {
  const ctx = await setupShotScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const sceneId = seedScene(ctx.stores, episodeId, "S", "D", 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId },
    });
    const res = await callShots(ctx.projectId, ctx.planId, sceneId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /script/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.5 Shots - an explicitly referenced missing or cross-episode script is a 404 without fallback", async () => {
  const wrongRefs: Array<{ name: string; scriptId: () => string; episode: () => string }> = [];
  const ctx = await setupShotScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const otherEpisodeId = seedEpisode(ctx.stores, ctx.projectId, "Other", 2);
    const foreignScriptId = seedScriptVersion(ctx.stores, otherEpisodeId, 1, validScriptText());
    wrongRefs.push(
      { name: "missing", scriptId: () => randomUUID(), episode: () => episodeId },
      { name: "cross-episode", scriptId: () => foreignScriptId, episode: () => episodeId },
    );
    for (const tc of wrongRefs) {
      const sceneId = seedScene(ctx.stores, tc.episode(), "S", "D", 1);
      await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
        plan: { story: MOZYTOON_STORY, episodeId: tc.episode(), scriptVersionId: tc.scriptId() },
      });
      const res = await callShots(ctx.projectId, ctx.planId, sceneId, ctx.cookie);
      assert.equal(res.status, 404, `${tc.name} script reference must be a 404`);
      assert.match(res.body.error.message, /script version/i);
    }
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.5 Shots - corrupted or schema-invalid stored script content is a 400", async () => {
  const invalidContents = ["this is not json at all", JSON.stringify({ title: 42, dialogue: [] })];
  for (const [i, content] of invalidContents.entries()) {
    const ctx = await setupShotScenario();
    try {
      const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
      const sceneId = seedScene(ctx.stores, episodeId, "S", "D", 1);
      const scriptId = seedScriptVersion(ctx.stores, episodeId, 1, content);
      await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
        plan: { story: MOZYTOON_STORY, episodeId, scriptVersionId: scriptId },
      });
      const res = await callShots(ctx.projectId, ctx.planId, sceneId, ctx.cookie);
      assert.equal(res.status, 400, `case ${i} must be a 400`);
      assert.equal(ctx.calls.length, 0, `case ${i} must not call the provider`);
      assert.equal(ctx.stores.shots.size, 0, `case ${i} must not write shots`);
    } finally {
      teardownDb();
    }
  }
});

// ---------------------------------------------------------------------------
// 13. Invalid plan state → 409
// ---------------------------------------------------------------------------

test("C7.5 Shots - only planning-state plans may generate shots (409)", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { status: "ready_for_review" });
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONFLICT");
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 14. No eligible text model → 400 without generateText calls
// ---------------------------------------------------------------------------

test("C7.5 Shots - no eligible text model yields 400 without generateText calls", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    ctx.stores.aiProviders.clear();
    ctx.stores.aiModels.clear();
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /text model/i);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 15. Provider failure → sanitized 502, existing shots preserved
// ---------------------------------------------------------------------------

test("C7.5 Shots - provider failure surfaces as 502 and preserves existing shots", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const manualId = seedShot(ctx.stores, ctx.sceneId, "Manual shot", 1);
    const first = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(first.status, 200);
    const trackedIds = (first.body.data!.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;

    ctx.state.respond = () => {
      throw new ProviderError("upstream exploded", { provider: "mock-text" });
    };
    const second = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(second.status, 502);
    assert.equal(second.body.error.code, "BAD_GATEWAY");
    assert.match(second.body.error.message, /Shot generation failed/);
    assert.match(second.body.error.message, /upstream exploded/);
    assert.equal(ctx.stores.shots.get(manualId)!.purpose, "Manual shot");
    for (const id of trackedIds) assert.ok(ctx.stores.shots.has(id));
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual((payload.shotIds as Record<string, string[]>)[ctx.sceneId], trackedIds);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 16. Non-ProviderError failures are sanitized
// ---------------------------------------------------------------------------

test("C7.5 Shots - unexpected (non-ProviderError) failures are collapsed to a generic message", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    ctx.state.respond = () => {
      throw new Error("internal path /var/secret with credentials sk-abc123");
    };
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 502);
    assert.equal(
      res.body.error.message,
      "Shot generation failed due to an unexpected provider error.",
    );
    assert.ok(!res.body.error.message.includes("sk-abc123"));
    assert.ok(!res.body.error.message.includes("/var/secret"));
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 17. Malformed JSON → 502 without writes
// ---------------------------------------------------------------------------

test("C7.5 Shots - malformed JSON output fails with 502 and writes nothing", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    ctx.state.respond = () => "Here are your shots, unfortunately [[ broken";
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, "BAD_GATEWAY");
    assert.equal(ctx.calls.length, 2); // script + failed shot call
    assert.equal(ctx.stores.shots.size, 0);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal(payload.shotIds, undefined);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 18. Schema-invalid output → 502 without writes
// ---------------------------------------------------------------------------

test("C7.5 Shots - schema-invalid outputs fail with 502 and write nothing", async () => {
  const baseShot = validShotList().shots[0]!;
  const invalidOutputs: string[] = [
    JSON.stringify({ shots: [] }),
    JSON.stringify({ shots: [{ ...baseShot, purpose: undefined }] }),
    JSON.stringify({ shots: [{ ...baseShot, shotType: " ".repeat(1) }] }),
    JSON.stringify({ shots: [{ ...baseShot, framing: "f".repeat(101) }] }),
    JSON.stringify({ shots: [{ ...baseShot, actionDescription: "a".repeat(2001) }] }),
    JSON.stringify({ shots: [{ ...baseShot, duration: 0 }] }),
    JSON.stringify({ shots: [{ ...baseShot, duration: -3 }] }),
    JSON.stringify({ shots: [{ ...baseShot, duration: 3601 }] }),
    JSON.stringify({ shots: [{ ...baseShot, duration: 4.5 }] }),
    JSON.stringify({
      shots: Array.from({ length: 11 }, () => ({ ...baseShot })),
    }),
    JSON.stringify({ notShots: true }),
  ];
  for (const [i, output] of invalidOutputs.entries()) {
    const ctx = await setupShotScenarioWithScene();
    try {
      ctx.state.respond = () => output;
      const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
      assert.equal(res.status, 502, `case ${i} should be a 502`);
      assert.equal(ctx.stores.shots.size, 0, `case ${i} must not write shots`);
    } finally {
      teardownDb();
    }
  }
});

// ---------------------------------------------------------------------------
// 19. Unknown output keys are stripped before persistence
// ---------------------------------------------------------------------------

test("C7.5 Shots - unknown AI-output keys are stripped by Zod before persistence", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    ctx.state.respond = () =>
      JSON.stringify({
        shots: [
          {
            ...validShotList().shots[0],
            orderIndex: 99,
            id: "ai-assigned-id",
            mediaPrompt: "ignore me",
          },
        ],
        storyboardNotes: "ignore me too",
      });
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
    assert.equal(res.status, 200);
    const shots = res.body.data!.shots as any[];
    assert.equal(shots.length, 1);
    assert.equal(shots[0].orderIndex, 1); // assigned by the service, not the AI
    const row = ctx.stores.shots.get(shots[0].id)!;
    assert.equal("mediaPrompt" in row, false);
    assert.equal("storyboardNotes" in row, false);
    assert.notEqual(row.id, "ai-assigned-id");
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal((payload.shotIds as Record<string, string[]>)[ctx.sceneId]!.length, 1);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 20. Prompt unit test — context embedded, layer rules enforced
// ---------------------------------------------------------------------------

test("C7.5 Shots - buildShotPrompt embeds story/script/scene and prohibits out-of-layer content", () => {
  const built = buildShotPrompt({
    plan: {
      request: MOZYTOON_REQUEST,
      targetDurationSeconds: 30,
      preferences: { audience: "kids" },
    },
    story: MOZYTOON_STORY,
    script: validScript(),
    scene: { name: "Gray Morning", description: "Mozy wakes to a colorless Toonville." },
  });

  assert.ok(built.userPrompt.includes(MOZYTOON_REQUEST));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.title));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.learningObjective));
  assert.ok(built.userPrompt.includes("Mimi, where did all the colors go?"));
  assert.ok(built.userPrompt.includes("Gray Morning"));
  assert.ok(built.userPrompt.includes("Target duration: about 30 seconds"));
  assert.ok(built.userPrompt.includes(JSON.stringify({ audience: "kids" })));
  assert.ok(built.userPrompt.includes('"shots"'));

  assert.ok(built.systemPrompt.includes("Do NOT rewrite, reword, or extend any dialogue"));
  assert.ok(built.systemPrompt.includes("Do NOT restructure the scene"));
  assert.ok(built.systemPrompt.includes("Do NOT include media-generation prompts"));
  assert.ok(built.systemPrompt.includes("Do NOT assign shot ids or order indexes"));
  assert.ok(built.systemPrompt.includes("between 1 and 10 shots"));
  assert.ok(built.systemPrompt.includes("EXACTLY one JSON object"));
  assert.ok(built.systemPrompt.includes("Do NOT wrap the JSON in markdown code fences"));
  assert.ok(built.systemPrompt.includes("Do not add story or educational content"));
});

// ---------------------------------------------------------------------------
// 21. JSON extraction + parse unit tests
// ---------------------------------------------------------------------------

test("C7.5 Shots - extractShotJsonObject tolerates fences and prose but rejects non-objects", () => {
  const object = { shots: validShotList().shots };
  assert.deepEqual(extractShotJsonObject(JSON.stringify(object)), object);
  assert.deepEqual(extractShotJsonObject("```json\n" + JSON.stringify(object) + "\n```"), object);
  assert.deepEqual(
    extractShotJsonObject("Sure! Shots:\n" + JSON.stringify(object) + "\nDone!"),
    object,
  );
  assert.throws(
    () => extractShotJsonObject("not json at all"),
    (err: unknown) => {
      assert.ok(err instanceof ShotGenerationError);
      assert.equal((err as ShotGenerationError).status, 502);
      return true;
    },
  );
  assert.throws(() => extractShotJsonObject("[1, 2, 3]"), ShotGenerationError);
  assert.throws(() => extractShotJsonObject('"just a string"'), ShotGenerationError);
});

test("C7.5 Shots - parseShotResponse validates the contract and strips unknown keys", () => {
  const valid = parseShotResponse(
    JSON.stringify({
      shots: [{ ...validShotList().shots[0], extra: "stripped" }],
      trailer: "stripped",
    }),
  );
  assert.deepEqual(valid, { shots: [validShotList().shots[0]] });

  assert.throws(() => parseShotResponse("{ broken"), ShotGenerationError);
  assert.throws(() => parseShotResponse(JSON.stringify({ shots: [] })), ShotGenerationError);
  assert.throws(
    () => parseShotResponse(JSON.stringify({ shots: [{ ...validShotList().shots[0], purpose: "" }] })),
    ShotGenerationError,
  );
});

// ---------------------------------------------------------------------------
// 22. Repeated generation follows the tracked replacement rules
// ---------------------------------------------------------------------------

test("C7.5 Shots - repeated generation is consistent with tracked replacement", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const manualId = seedShot(ctx.stores, ctx.sceneId, "Manual shot", 1);
    const seenIdSets: string[][] = [];
    for (let round = 0; round < 3; round++) {
      const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, ctx.cookie);
      assert.equal(res.status, 200);
      const ids = (res.body.data!.plan.shotIds as Record<string, string[]>)[ctx.sceneId]!;
      assert.equal(ids.length, 3);
      seenIdSets.push(ids);
      assert.equal(ctx.stores.shots.get(manualId)!.purpose, "Manual shot");
      assert.equal(ctx.stores.shots.size, 4); // 1 manual + 3 generated
      if (round > 0) {
        for (const id of seenIdSets[round - 1]!) assert.equal(ctx.stores.shots.has(id), false);
      }
      assert.deepEqual(
        (res.body.data!.shots as any[]).map((s) => s.orderIndex),
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
// 23. Cross-user and cross-project isolation
// ---------------------------------------------------------------------------

test("C7.5 Shots - another user's project is invisible (404, not 403)", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const otherCookie = await userSession(ctx.stores, "intruder@example.com");
    const res = await callShots(ctx.projectId, ctx.planId, ctx.sceneId, otherCookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.5 Shots - plan must belong to the requested project (404)", async () => {
  const ctx = await setupShotScenarioWithScene();
  try {
    const otherCookie = await userSession(ctx.stores, "second@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Second Project");
    const res = await callShots(otherProjectId, ctx.planId, ctx.sceneId, otherCookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});
