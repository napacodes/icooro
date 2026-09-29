// ---------------------------------------------------------------------------
// C7.7 — Production plan orchestration (gap-fill sequence over C7.2–C7.6)
//
// One synchronous call completes the REMAINING planning stages by calling
// the existing stage services in order. All providers here are
// deterministic in-process mocks — NO real OpenAI/Gemini/ChatFire call can
// ever happen (guarded by a global fetch tripwire). No ai_jobs or
// shot_versions rows are ever created, and no media generation runs.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import type { ScriptContract, StoryContract } from "@icooro/shared";
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
  aiJobs: Map<string, Record<string, unknown>>;
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
    if (name === "ai_jobs") return stores.aiJobs;
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
          const name = tableNameOf(table);
          const store = storeFor(table);
          const newId = (vals.id as string) ?? randomUUID();
          const now = new Date();
          const defaulted: Record<string, unknown> = { id: newId, ...vals };
          if (defaulted.createdAt === undefined) defaulted.createdAt = now;
          if (defaulted.updatedAt === undefined) defaulted.updatedAt = now;
          // Real MySQL stores unset nullable/JSON columns as NULL, not
          // "missing". Mirror that so null-guards in the services observe
          // the same values they would in production.
          for (const key of Object.keys(defaulted)) {
            if (defaulted[key] === undefined) defaulted[key] = null;
          }
          // C7.5's shot insert omits the nullable columns MySQL fills with
          // NULL (prompt, dialogue, productionNotes). Absent keys would fail
          // C7.6's strict row type checks (undefined !== null); real MySQL
          // never produces that shape.
          if (name === "shots") {
            for (const col of ["prompt", "dialogue", "productionNotes"]) {
              if (!(col in defaulted)) defaulted[col] = null;
            }
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

// --- Deterministic switchable mock text provider -----------------------------

interface SwitchableMockAdapter {
  calls: TextGenerationParams[];
  state: {
    respond: (params: TextGenerationParams) => string;
    /** One-shot gate: blocks the NEXT generateText call exactly once. */
    gate?: Promise<void> | null;
  };
}

function installSwitchableMockAdapter(): SwitchableMockAdapter {
  const calls: TextGenerationParams[] = [];
  const state: SwitchableMockAdapter["state"] = { respond: () => "", gate: null };
  registerAdapterFactory("mock-text", "Mock Text Provider", ["text"], () => ({
    providerType: "mock-text",
    name: "Mock Text Provider",
    capabilities: ["text"],
    testConnection: async () => ({ ok: true }),
    generateText: async (params: TextGenerationParams) => {
      calls.push({ ...params });
      if (state.gate) {
        const gate = state.gate;
        state.gate = null; // one-shot: only the first call blocks
        await gate;
      }
      return { text: state.respond(params) };
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
    name: "Orchestration model",
    modelId: "mock-orchestration-model-1",
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

function validScriptText(): string {
  const script: ScriptContract = {
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
  };
  return JSON.stringify(script);
}

function validSceneListText(): string {
  return JSON.stringify({
    scenes: [
      { name: "Gray Morning", description: "Mozy wakes to find Toonville drained of all color." },
      { name: "Palette's Clue", description: "Professor Palette reveals the first color clue." },
      { name: "Colors Return", description: "The trio restores red, yellow, and blue." },
    ],
  });
}

function validShotListText(): string {
  return JSON.stringify({
    shots: [
      {
        purpose: "Establish the town",
        shotType: "wide",
        framing: "full shot",
        cameraMovement: "slow pan",
        cameraAngle: "eye level",
        actionDescription: "Mozy looks out over the gray streets of Toonville.",
        visualDescription: "A desaturated town; Mozy small against the skyline.",
        transition: "cut to",
        duration: 8,
      },
    ],
  });
}

function validPromptText(): string {
  return JSON.stringify({
    prompt: "A wide shot of a small cartoon town on a gray morning; desaturated streets.",
  });
}

/**
 * Stage-aware responder: picks the output by the contract key each stage's
 * user prompt asks for ("premise" → story, "dialogue" → script, "scenes" →
 * scenes, "shots" → shots, "prompt" → prompts). Order matters: "prompt" is
 * checked before "shots" because a shot prompt contains both words. This
 * keeps tests correct regardless of how many provider calls a stage makes.
 */
function stageAwareResponder(
  overrides: Partial<{
    story: () => string;
    script: () => string;
    scenes: () => string;
    shots: () => string;
    prompts: () => string;
  }> = {},
): (params: TextGenerationParams) => string {
  return (params) => {
    const prompt = params.prompt;
    if (prompt.includes('"prompt"')) return (overrides.prompts ?? validPromptText)();
    if (prompt.includes('"shots"')) return (overrides.shots ?? validShotListText)();
    if (prompt.includes('"scenes"')) return (overrides.scenes ?? validSceneListText)();
    if (prompt.includes('"dialogue"')) return (overrides.script ?? validScriptText)();
    return (overrides.story ?? ( () => JSON.stringify(MOZYTOON_STORY) ))();
  };
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

async function seedProject(stores: Stores, cookie: string, name = "Orchestration Project"): Promise<string> {
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

async function orchestrate(
  projectId: string,
  planId: string,
  cookie: string,
  body?: Record<string, unknown>,
) {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/orchestrate`,
    { method: "POST", cookie, body: body ? JSON.stringify(body) : undefined },
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } };
}

function stageOf(report: any, stage: string) {
  return (report?.stages as any[]).find((s) => s.stage === stage);
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

type SeedShotOverrides = Partial<{ prompt: string | null }>;

function seedShot(stores: Stores, sceneId: string, orderIndex: number, overrides: SeedShotOverrides = {}): string {
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
    prompt: null,
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

async function withFetchTripwire<T>(fn: () => Promise<T>): Promise<{ result: T; tripwireHits: number }> {
  let tripwireHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    tripwireHits += 1;
    throw new Error("TRIPWIRE: external network call attempted during orchestration");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- Scenario helpers ---------------------------------------------------------

/** Fresh plan (status planning, empty payload) + routed mock model. */
async function setupFreshPlanScenario(respond?: (params: TextGenerationParams) => string) {
  const mock = installSwitchableMockAdapter();
  mock.state.respond = respond ?? stageAwareResponder();
  const stores = setupDb();
  const cookie = await userSession(stores);
  const projectId = await seedProject(stores, cookie);
  const created = await createPlan(cookie, projectId);
  assert.equal(created.status, 201);
  const planId = created.body.data!.id;
  seedTextProviderAndModel(stores);
  return { mock, stores, cookie, projectId, planId };
}

/**
 * Plan that has been through story + script via the real C7.2/C7.3 services
 * (so payload references and episode/script rows are exactly what a partial
 * run leaves behind), with the responder switched for the next stage.
 */
async function setupPlanThroughScript(respond?: (params: TextGenerationParams) => string) {
  const mock = installSwitchableMockAdapter();
  // Story route first, then script route — the stage-aware responder serves
  // each correctly.
  mock.state.respond = stageAwareResponder();
  const stores = setupDb();
  const cookie = await userSession(stores);
  const projectId = await seedProject(stores, cookie);
  const created = await createPlan(cookie, projectId);
  assert.equal(created.status, 201);
  const planId = created.body.data!.id;
  seedTextProviderAndModel(stores);

  // Story via the real C7.2 route.
  const storyRes = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/story`,
    { method: "POST", cookie },
  );
  assert.equal(storyRes.status, 200);

  // Script via the real C7.3 route.
  const scriptRes = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/script`,
    { method: "POST", cookie },
  );
  assert.equal(scriptRes.status, 200);
  const scriptData = ((await scriptRes.json()) as { data: any }).data;

  mock.state.respond = respond ?? stageAwareResponder();
  return {
    mock,
    stores,
    cookie,
    projectId,
    planId,
    episodeId: scriptData.episode.id as string,
    scriptVersionId: scriptData.scriptVersion.id as string,
  };
}

// ---------------------------------------------------------------------------
// 1. Fresh full orchestration runs stages in the required order
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - fresh plan runs story, script, scenes, shots, prompts in order", async () => {
  const ctx = await setupFreshPlanScenario();
  try {
    const { result, tripwireHits } = await withFetchTripwire(() =>
      orchestrate(ctx.projectId, ctx.planId, ctx.cookie),
    );
    assert.equal(tripwireHits, 0, "no external network call may occur");
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.requestedTo, null);
    assert.deepEqual(
      report.stages.map((s: any) => [s.stage, s.status]),
      [
        ["story", "completed"],
        ["script", "completed"],
        ["scenes", "completed"],
        ["shots", "completed"],
        ["prompts", "completed"],
      ],
    );
    // 1 story + 1 script + 1 scenes + 3 shot sets + 3 prompts.
    assert.equal(ctx.mock.calls.length, 9, "one provider call per stage unit");
    assert.equal(ctx.mock.calls[0]!.modelId, "mock-orchestration-model-1");

    // Domain rows: 1 episode, 1 script, 3 scenes, 3 shots (one per scene), 3 prompts.
    assert.equal(ctx.stores.episodes.size, 1);
    assert.equal(ctx.stores.scripts.size, 1);
    assert.equal(ctx.stores.scenes.size, 3);
    assert.equal(ctx.stores.shots.size, 3);
    const prompts = Array.from(ctx.stores.shots.values()).map((s) => s.prompt);
    assert.ok(prompts.every((p) => typeof p === "string" && p.length > 0));

    // Plan payload carries every reference key; plan stays planning.
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.ok(payload.story);
    assert.ok(typeof payload.episodeId === "string");
    assert.ok(typeof payload.scriptVersionId === "string");
    assert.equal((payload.sceneIds as string[]).length, 3);
    assert.equal(Object.keys(payload.shotIds as Record<string, string[]>).length, 3);
    assert.equal((payload.promptedShotIds as string[]).length, 3);
    assert.equal(ctx.stores.productionPlans.get(ctx.planId)!.status, "planning");

    // The report echoes the final payload.
    assert.deepEqual(report.plan, payload);

    // No media-generation artifacts.
    assert.equal(ctx.stores.aiJobs.size, 0);
    assert.equal(ctx.stores.shotVersions.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Existing valid outputs are skipped
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - a plan with valid existing outputs skips those stages", async () => {
  const ctx = await setupPlanThroughScript();
  try {
    const { result } = await withFetchTripwire(() =>
      orchestrate(ctx.projectId, ctx.planId, ctx.cookie),
    );
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(stageOf(report, "story").status, "skipped");
    assert.equal(stageOf(report, "script").status, "skipped");
    assert.equal(stageOf(report, "scenes").status, "completed");
    assert.equal(stageOf(report, "shots").status, "completed");
    assert.equal(stageOf(report, "prompts").status, "completed");
    // Exactly the calls for scenes (1) + shots (3) + prompts (3); the skipped
    // story and script stages made no provider calls.
    assert.equal(ctx.mock.calls.length - 2, 7);
    // No duplicate script version was created.
    assert.equal(ctx.stores.scripts.size, 1);
    assert.equal(ctx.stores.episodes.size, 1);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Retry after partial success creates no duplicates
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - retry after partial success creates no duplicate script versions or shots", async () => {
  // First run: the scenes stage fails on a malformed scene list.
  const ctx = await setupFreshPlanScenario(
    stageAwareResponder({ scenes: () => "not json at all {{{" }),
  );
  try {
    const first = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(first.status, 200);
    assert.equal(first.body.data!.status, "failed");
    assert.equal(stageOf(first.body.data!, "scenes").status, "failed");
    assert.equal(stageOf(first.body.data!, "shots").status, "not_run");
    assert.equal(stageOf(first.body.data!, "prompts").status, "not_run");
    assert.equal(ctx.stores.scripts.size, 1);
    assert.equal(ctx.stores.scenes.size, 0);

    // Retry with valid outputs: only the missing stages run.
    ctx.mock.state.respond = stageAwareResponder();
    const second = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 200);
    const report = second.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(stageOf(report, "story").status, "skipped");
    assert.equal(stageOf(report, "script").status, "skipped");
    assert.equal(stageOf(report, "scenes").status, "completed");
    assert.equal(stageOf(report, "shots").status, "completed");
    assert.equal(stageOf(report, "prompts").status, "completed");

    // Still exactly one script version and one episode.
    assert.equal(ctx.stores.scripts.size, 1);
    assert.equal(ctx.stores.episodes.size, 1);
    assert.equal(ctx.stores.scenes.size, 3);
    assert.equal(ctx.stores.shots.size, 3);

    // A third run changes nothing: every stage is skipped.
    const before = {
      scripts: ctx.stores.scripts.size,
      scenes: ctx.stores.scenes.size,
      shots: ctx.stores.shots.size,
      calls: ctx.mock.calls.length,
    };
    const third = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(third.status, 200);
    assert.equal(third.body.data!.status, "completed");
    for (const stage of ["story", "script", "scenes", "shots", "prompts"]) {
      assert.equal(stageOf(third.body.data!, stage).status, "skipped", stage);
    }
    assert.equal(ctx.mock.calls.length, before.calls, "no provider calls on a fully completed plan");
    assert.equal(ctx.stores.scripts.size, before.scripts);
    assert.equal(ctx.stores.scenes.size, before.scenes);
    assert.equal(ctx.stores.shots.size, before.shots, "no duplicate shots after re-run");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Manual scenes, shots, prompts and unrelated payload keys are preserved
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - manual scenes/shots/prompts and unrelated payload keys are preserved", async () => {
  const ctx = await setupPlanThroughScript();
  try {
    // Manual scene + manual shot + manual prompt on the episode.
    const manualSceneId = seedScene(ctx.stores, ctx.episodeId, "Manual scene", "By hand.", 5);
    const manualShotId = seedShot(ctx.stores, manualSceneId, 1);
    ctx.stores.shots.set(manualShotId, {
      ...ctx.stores.shots.get(manualShotId)!,
      prompt: "Hand-tuned cinematic prompt; do not lose this.",
    });

    // Unrelated payload key.
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: {
        ...((ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>),
        userNote: "keep me",
      },
    });

    const { result } = await withFetchTripwire(() =>
      orchestrate(ctx.projectId, ctx.planId, ctx.cookie),
    );
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "completed");

    // Manual scene untouched, its manual shot untouched, its prompt intact.
    const manualScene = ctx.stores.scenes.get(manualSceneId)!;
    assert.equal(manualScene.name, "Manual scene");
    assert.equal(manualScene.orderIndex, 5);
    const manualShot = ctx.stores.shots.get(manualShotId)!;
    assert.equal(manualShot.prompt, "Hand-tuned cinematic prompt; do not lose this.");

    // Generated scenes append after the manual one; the manual shot got NO
    // prompt (it is not a tracked shot and was never a target).
    assert.equal(ctx.stores.scenes.size, 4);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal(payload.userNote, "keep me");
    assert.equal((payload.sceneIds as string[]).length, 3);
    assert.ok(!(payload.sceneIds as string[]).includes(manualSceneId));
    const prompted = payload.promptedShotIds as string[];
    assert.equal(prompted.length, 3);
    assert.ok(!prompted.includes(manualShotId), "manual prompt must never be overwritten");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Missing tracked scenes and shots are reported and not recreated
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - missing tracked scenes and shots are reported and not recreated", async () => {
  const ctx = await setupPlanThroughScript();
  try {
    // Run scenes so tracked ids exist.
    const first = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie, { to: "scenes" });
    assert.equal(first.status, 200);
    const trackedScenes = (first.body.data!.plan.sceneIds as string[]).slice();
    assert.equal(trackedScenes.length, 3);

    // Manually delete one tracked scene.
    const removedSceneId = trackedScenes[0]!;
    ctx.stores.scenes.delete(removedSceneId);
    const survivorSceneId = trackedScenes[1]!;

    // Give the surviving scene a tracked shot, then manually delete it.
    const shotsRes = await jsonRequest(
      `/api/v1/projects/${ctx.projectId}/production-plans/${ctx.planId}/scenes/${survivorSceneId}/shots`,
      { method: "POST", cookie: ctx.cookie },
    );
    assert.equal(shotsRes.status, 200);
    const trackedShots = ((await shotsRes.json()) as { data: any }).data.plan.shotIds[
      survivorSceneId
    ] as string[];
    assert.equal(trackedShots.length, 1);
    const removedShotId = trackedShots[0]!;
    ctx.stores.shots.delete(removedShotId);

    // Full orchestration: scenes partial (missing reported), shots partial
    // over the tracked set, prompts skipped (the only tracked shot is gone).
    const second = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(second.status, 200);
    const report = second.body.data!;
    assert.equal(report.status, "partial");
    assert.equal(stageOf(report, "story").status, "skipped");
    assert.equal(stageOf(report, "script").status, "skipped");
    const scenesStage = stageOf(report, "scenes");
    assert.equal(scenesStage.status, "partial");
    assert.deepEqual(scenesStage.missingTrackedIds, [removedSceneId]);
    const shotsStage = stageOf(report, "shots");
    assert.equal(shotsStage.status, "partial");
    assert.ok(shotsStage.missingTrackedIds!.includes(removedShotId));
    assert.ok(shotsStage.missingTrackedIds!.includes(removedSceneId));
    assert.equal(stageOf(report, "prompts").status, "completed");

    // Nothing was recreated: the deleted rows stay gone. The one shot row is
    // the set the shots stage gap-filled for the third scene (which had no
    // tracked shots before this run).
    assert.equal(ctx.stores.scenes.has(removedSceneId), false);
    assert.equal(ctx.stores.shots.has(removedShotId), false);
    assert.equal(ctx.stores.shots.size, 1);

    // The third tracked scene (no tracked shots before this run) got a
    // tracked shot set, and its shot received a prompt.
    const untouchedSceneId = trackedScenes[2]!;
    const untouchedShots = Array.from(ctx.stores.shots.values()).filter(
      (s) => s.sceneId === untouchedSceneId,
    );
    assert.equal(untouchedShots.length, 1);
    assert.ok(typeof untouchedShots[0]!.prompt === "string");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6 + 7. Stage failure stops later stages; earlier outputs stay persisted
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - a shots-stage failure stops prompts and keeps earlier outputs", async () => {
  const ctx = await setupPlanThroughScript();
  try {
    // Scenes succeed first (via the real C7.4 route).
    const scenesRes = await jsonRequest(
      `/api/v1/projects/${ctx.projectId}/production-plans/${ctx.planId}/scenes`,
      { method: "POST", cookie: ctx.cookie },
    );
    assert.equal(scenesRes.status, 200);
    const trackedScenes = ((await scenesRes.json()) as { data: any }).data.plan.sceneIds as string[];

    // Swap in a failing provider for the shots stage.
    ctx.mock.state.respond = stageAwareResponder({
      shots: () => {
        throw new ProviderError("upstream exploded", { provider: "mock-text" });
      },
    });
    const { result } = await withFetchTripwire(() =>
      orchestrate(ctx.projectId, ctx.planId, ctx.cookie),
    );
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "failed");
    assert.equal(stageOf(report, "story").status, "skipped");
    assert.equal(stageOf(report, "script").status, "skipped");
    assert.equal(stageOf(report, "scenes").status, "skipped");
    assert.equal(stageOf(report, "shots").status, "failed");
    assert.match(stageOf(report, "shots").reason, /Shot generation failed/);
    assert.equal(stageOf(report, "prompts").status, "not_run");

    // Earlier outputs persisted: script version, scenes, plan payload.
    assert.equal(ctx.stores.scripts.size, 1);
    assert.equal(ctx.stores.scenes.size, 3);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.sceneIds, trackedScenes);
    assert.equal(ctx.stores.shots.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8. `to` limits the sequence
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - `to` bounds the sequence to the requested stage", async () => {
  const ctx = await setupFreshPlanScenario();
  try {
    const { result } = await withFetchTripwire(() =>
      orchestrate(ctx.projectId, ctx.planId, ctx.cookie, { to: "scenes" }),
    );
    assert.equal(result.status, 200);
    const report = result.body.data!;
    assert.equal(report.status, "completed");
    assert.equal(report.requestedTo, "scenes");
    assert.deepEqual(
      report.stages.map((s: any) => s.stage),
      ["story", "script", "scenes"],
    );
    assert.equal(ctx.mock.calls.length, 3);
    assert.equal(ctx.stores.shots.size, 0);
    assert.equal(ctx.stores.scenes.size, 3);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 9. Request-level rejections
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - invalid body, missing plan, ownership mismatch, invalid status are rejected", async () => {
  const ctx = await setupFreshPlanScenario();
  try {
    // Invalid body: unknown `to` value.
    const badTo = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie, { to: "media" });
    assert.equal(badTo.status, 400);
    assert.equal(badTo.body.error!.code, "INVALID_REQUEST");

    // Invalid body: malformed JSON.
    const malformed = await jsonRequest(
      `/api/v1/projects/${ctx.projectId}/production-plans/${ctx.planId}/orchestrate`,
      { method: "POST", cookie: ctx.cookie, body: "not json at all" },
    );
    assert.equal(malformed.status, 400);

    // Missing plan.
    const missing = await orchestrate(ctx.projectId, randomUUID(), ctx.cookie);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error!.message, "Production plan not found");

    // Ownership mismatch: another user's project is invisible (404, not 403).
    const otherCookie = await userSession(ctx.stores, "intruder@example.com");
    const foreign = await orchestrate(ctx.projectId, ctx.planId, otherCookie);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error!.message, "Project not found");

    // Plan addressed under the wrong project (same owner) is a 404 too.
    const projectB = await seedProject(ctx.stores, ctx.cookie, "B");
    const wrongProject = await orchestrate(projectB, ctx.planId, ctx.cookie);
    assert.equal(wrongProject.status, 404);
    assert.equal(wrongProject.body.error!.message, "Production plan not found");

    // Invalid plan status: ready_for_review and approved are refused.
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { status: "ready_for_review" });
    const inReview = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(inReview.status, 409);
    assert.match(inReview.body.error!.message, /planning/);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { status: "approved" });
    const approved = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(approved.status, 409);

    // No provider call was ever made by the rejected requests.
    assert.equal(ctx.mock.calls.length, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 10. No eligible text model is reported as a failed story stage
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - no eligible text model is reported as a failed story stage", async () => {
  const ctx = await setupFreshPlanScenario();
  try {
    ctx.stores.aiProviders.clear();
    ctx.stores.aiModels.clear();
    // Stage-level failures are report data (HTTP 200), not request errors.
    const { status, body } = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(status, 200);
    assert.equal(body.data!.status, "failed");
    const story = stageOf(body.data!, "story");
    assert.equal(story.status, "failed");
    assert.match(story.reason, /No enabled text model/);
    assert.equal(stageOf(body.data!, "script").status, "not_run");
    assert.equal(ctx.mock.calls.length, 0);
    assert.equal(ctx.stores.scenes.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 11. Concurrency: same plan 409, different plans proceed
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - concurrent same-plan request returns 409; other plans proceed", async () => {
  const ctx = await setupFreshPlanScenario();
  try {
    // One-shot gate: the FIRST provider call blocks until released, so the
    // first orchestration stays in flight.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    ctx.mock.state.gate = gate;

    const firstPromise = orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    // Let the first request reach the provider call.
    await new Promise((r) => setTimeout(r, 25));

    const concurrent = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.error!.code, "CONFLICT");

    // Release the gate and let the first run finish.
    releaseGate();
    const first = await firstPromise;
    assert.equal(first.status, 200);
    assert.equal(first.body.data!.status, "completed");

    // A different plan is NOT blocked by the (now finished) first run.
    const otherPlan = await createPlan(ctx.cookie, ctx.projectId);
    assert.equal(otherPlan.status, 201);
    const otherId = otherPlan.body.data!.id;
    const otherRun = await orchestrate(ctx.projectId, otherId, ctx.cookie);
    assert.equal(otherRun.status, 200);
    assert.equal(otherRun.body.data!.status, "completed");

    // The guard released: another run on the same plan now proceeds.
    const after = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(after.status, 200);
    assert.equal(after.body.data!.status, "completed");
    assert.equal(stageOf(after.body.data!, "story").status, "skipped");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 12. Plan remains in planning
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - the plan stays in planning after a successful full run", async () => {
  const ctx = await setupFreshPlanScenario();
  try {
    const res = await orchestrate(ctx.projectId, ctx.planId, ctx.cookie);
    assert.equal(res.status, 200);
    const planRow = ctx.stores.productionPlans.get(ctx.planId)!;
    assert.equal(planRow.status, "planning");
    assert.notEqual(planRow.status, "ready_for_review");
    assert.notEqual(planRow.status, "approved");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 13. No media generation artifacts are created
// ---------------------------------------------------------------------------

test("C7.7 Orchestrate - no ai_jobs or shot_versions rows are ever created", async () => {
  const ctx = await setupFreshPlanScenario();
  try {
    const { result, tripwireHits } = await withFetchTripwire(() =>
      orchestrate(ctx.projectId, ctx.planId, ctx.cookie),
    );
    assert.equal(result.status, 200);
    assert.equal(tripwireHits, 0);
    assert.equal(ctx.stores.aiJobs.size, 0);
    assert.equal(ctx.stores.shotVersions.size, 0);
  } finally {
    teardownDb();
  }
});
