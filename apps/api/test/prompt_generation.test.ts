// ---------------------------------------------------------------------------
// C7.6 — AI Media Prompt Generation (existing `shots.prompt`, plan refs)
//
// ProductionPlan → validated Story + Script + Scene + Shot → generic text
// provider → ONE media prompt → the shot's EXISTING `shots.prompt` column.
// All providers here are deterministic in-process mocks — NO real
// OpenAI/Gemini/ChatFire call can ever happen (guarded by a global fetch
// tripwire). `shot_versions` and `ai_jobs` are NEVER written.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import type { ScriptContract, StoryContract } from "@icooro/shared";
import {
  PromptGenerationError,
  extractPromptJsonObject,
  parsePromptResponse,
} from "../src/services/prompt_generation.js";
import { buildMediaPrompt } from "../src/services/media_prompt.js";
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
    name: "Prompt model",
    modelId: "mock-prompt-model-1",
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

function validPromptText(): string {
  return JSON.stringify({
    prompt: "A wide shot of a small cartoon town on a gray morning; desaturated streets, a small character at a window gazing outward.",
  });
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

async function seedProject(stores: Stores, cookie: string, name = "Prompt Project"): Promise<string> {
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

async function callPrompt(
  projectId: string,
  planId: string,
  sceneId: string,
  shotId: string,
  cookie: string,
) {
  const res = await jsonRequest(
    `/api/v1/projects/${projectId}/production-plans/${planId}/scenes/${sceneId}/shots/${shotId}/prompt`,
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

type SeedShotOverrides = Partial<{
  prompt: string | null;
  purpose: string | null;
  shotType: string | null;
  framing: string | null;
  cameraMovement: string | null;
  cameraAngle: string | null;
  actionDescription: string | null;
  visualDescription: string | null;
  transition: string | null;
  duration: number | null;
  dialogue: string | null;
}>;

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
    visualDescription: "A desaturated town; Mozy small against the skyline.",
    actionDescription: "Mozy looks out over the gray streets of Toonville.",
    dialogue: "Mimi, where did all the colors go?",
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

function seedAiJob(stores: Stores, shotId: string): string {
  const id = randomUUID();
  stores.aiJobs.set(id, {
    id,
    jobType: "video",
    status: "queued",
    projectId: null,
    shotId,
    prompt: "pre-existing manual job prompt",
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
    throw new Error("TRIPWIRE: external network call attempted during prompt generation");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- Scenario setup ------------------------------------------------------------

type PromptScenarioOptions = {
  extraPlanPayload?: Record<string, unknown>;
};

/** Plan with a story in its payload (what C7.2 leaves behind). */
async function setupPromptScenario(options: PromptScenarioOptions = {}) {
  const { calls, state } = installSwitchableMockAdapter();
  state.respond = () => validScriptText();
  const stores = setupDb();
  const cookie = await userSession(stores);
  const projectId = await seedProject(stores, cookie);
  const created = await createPlan(cookie, projectId, {
    targetDurationSeconds: null,
    preferences: { audience: "kids", tone: "playful" },
  });
  assert.equal(created.status, 201);
  const planId = created.body.data!.id;
  await patchPlan(cookie, projectId, planId, {
    plan: { story: MOZYTOON_STORY, ...(options.extraPlanPayload ?? {}) },
  });
  seedTextProviderAndModel(stores);
  return { calls, state, stores, cookie, projectId, planId };
}

/** Plan that has been through C7.3 (real script + episode) plus a scene and two shots. */
async function setupPromptScenarioWithShot(options: PromptScenarioOptions = {}) {
  const ctx = await setupPromptScenario(options);
  const scriptRes = await generateScript(ctx.projectId, ctx.planId, ctx.cookie);
  assert.equal(scriptRes.status, 200);
  ctx.state.respond = () => validPromptText();
  const scriptData = (scriptRes.body as { data: any }).data!;
  const episodeId = scriptData.episode.id as string;
  const sceneId = seedScene(
    ctx.stores,
    episodeId,
    "Gray Morning",
    "Mozy wakes to find Toonville drained of all color.",
    1,
  );
  const shotId = seedShot(ctx.stores, sceneId, 1);
  const otherShotId = seedShot(ctx.stores, sceneId, 2, {
    purpose: "Show the discovery",
    dialogue: "Look — Professor Palette has a clue!",
  });
  return {
    ...ctx,
    episodeId,
    scriptVersionId: scriptData.scriptVersion.id as string,
    sceneId,
    shotId,
    otherShotId,
  };
}

// ---------------------------------------------------------------------------
// 1. Successful generation — representative Mozytoon request (full pipeline)
// ---------------------------------------------------------------------------

test("C7.6 Prompt - successful generation writes shots.prompt and tracks the shot (Mozytoon request)", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    // Existing media lineage + job rows must remain untouched by C7.6.
    const shotVersionId = seedShotVersion(ctx.stores, ctx.shotId);
    const aiJobId = seedAiJob(ctx.stores, ctx.shotId);
    const shotVersionBefore = { ...ctx.stores.shotVersions.get(shotVersionId)! };
    const aiJobBefore = { ...ctx.stores.aiJobs.get(aiJobId)! };

    const { result, tripwireHits } = await withFetchTripwire(() =>
      callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie),
    );
    assert.equal(tripwireHits, 0, "no external network call may occur");
    assert.equal(result.status, 200);
    const data = result.body.data!;
    assert.equal(data.shot.id, ctx.shotId);
    assert.equal(data.shot.sceneId, ctx.sceneId);
    assert.match(data.shot.prompt, /gray morning/);
    assert.equal(data.scriptVersion.id, ctx.scriptVersionId);
    assert.equal(ctx.calls.length, 2); // once for script (C7.3), once for prompt
    assert.equal(ctx.calls[1].modelId, "mock-prompt-model-1");
    assert.ok(typeof ctx.calls[1].systemPrompt === "string" && ctx.calls[1].systemPrompt.length > 0);

    // The prompt landed in the existing shots.prompt column.
    const row = ctx.stores.shots.get(ctx.shotId)!;
    assert.equal(row.prompt, data.shot.prompt);
    // shot_versions and ai_jobs were NOT written.
    assert.deepEqual(ctx.stores.shotVersions.get(shotVersionId)!, shotVersionBefore);
    assert.deepEqual(ctx.stores.aiJobs.get(aiJobId)!, aiJobBefore);
    // The sibling shot is untouched.
    assert.equal(ctx.stores.shots.get(ctx.otherShotId)!.prompt ?? null, null);

    // Plan payload records AI authorship and preserves unrelated keys.
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.promptedShotIds, [ctx.shotId]);
    assert.deepEqual(payload.story, MOZYTOON_STORY);
    assert.equal(payload.episodeId, ctx.episodeId);
    assert.equal(payload.scriptVersionId, ctx.scriptVersionId);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Regeneration of a tracked prompt overwrites the AI-authored prompt
// ---------------------------------------------------------------------------

test("C7.6 Prompt - regeneration of a tracked shot overwrites its AI prompt", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    const first = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(first.status, 200);
    const firstPrompt = first.body.data!.shot.prompt as string;

    ctx.state.respond = () =>
      JSON.stringify({ prompt: "Regenerated: close-up of Mozy's puzzled face, low angle, soft light." });
    const second = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(second.status, 200);
    const secondPrompt = second.body.data!.shot.prompt as string;
    assert.notEqual(secondPrompt, firstPrompt);
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt, secondPrompt);
    // Tracking stays a single, idempotent entry.
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.promptedShotIds, [ctx.shotId]);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Manual untracked prompt is preserved with a 409
// ---------------------------------------------------------------------------

test("C7.6 Prompt - a manual edit during generation aborts with 409 and the manual prompt survives", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    // Simulate the race: the mock provider resolves only after a manual
    // prompt edit has landed on the shot — after the pre-provider
    // preservation gate (step 8) but before the persist step.
    const manualPrompt = "Edited by hand while the AI was generating; must survive.";
    ctx.state.respond = () => {
      ctx.stores.shots.set(ctx.shotId, {
        ...ctx.stores.shots.get(ctx.shotId)!,
        prompt: manualPrompt,
      });
      return validPromptText();
    };

    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONFLICT");
    assert.match(res.body.error.message, /edited while the media prompt was being generated/i);
    // The manual edit survives; no AI prompt overwrote it; no tracking.
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt, manualPrompt);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal(payload.promptedShotIds, undefined);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. Manual untracked prompt is preserved with a 409
// ---------------------------------------------------------------------------

test("C7.6 Prompt - a manually authored untracked prompt returns 409 and changes nothing", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    const manualPrompt = "Hand-tuned cinematic prompt; do not lose this.";
    ctx.stores.shots.set(ctx.shotId, { ...ctx.stores.shots.get(ctx.shotId)!, prompt: manualPrompt });
    const before = { ...ctx.stores.shots.get(ctx.shotId)! };

    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONFLICT");
    assert.match(res.body.error.message, /manually authored prompt/i);
    assert.deepEqual(ctx.stores.shots.get(ctx.shotId)!, before);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal(payload.promptedShotIds, undefined);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Null untracked prompt generates (manual shot handed to AI)
// ---------------------------------------------------------------------------

test("C7.6 Prompt - a manual shot with a null prompt generates and is tracked", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    // The seeded shot is untracked with a null prompt: generation is allowed.
    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 200);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.promptedShotIds, [ctx.shotId]);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Cross-scope shots are indistinguishable 404s
// ---------------------------------------------------------------------------

test("C7.5 Prompt - missing, moved, and cross-scope shots are 404s without calls", async () => {
  const cases: Array<{ name: string; shotId: () => string; sceneId: () => string }> = [];
  const ctx = await setupPromptScenarioWithShot();
  try {
    const otherEpisodeId = seedEpisode(ctx.stores, ctx.projectId, "Episode 2", 2);
    const foreignSceneId = seedScene(ctx.stores, otherEpisodeId, "Foreign scene", "D", 1);
    const foreignSceneShotId = seedShot(ctx.stores, foreignSceneId, 1);
    const otherCookie = await userSession(ctx.stores, "other@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Other Project");
    const foreignEpisodeId = seedEpisode(ctx.stores, otherProjectId, "Foreign", 1);
    const foreignProjectSceneId = seedScene(ctx.stores, foreignEpisodeId, "S", "D", 1);
    const foreignProjectShotId = seedShot(ctx.stores, foreignProjectSceneId, 1);

    cases.push(
      { name: "missing shot", shotId: () => randomUUID(), sceneId: () => ctx.sceneId },
      // A shot of another scene in the same project, addressed via the target scene.
      { name: "shot of another scene", shotId: () => foreignSceneShotId, sceneId: () => ctx.sceneId },
      // The target shot addressed via a foreign scene id.
      { name: "target shot via foreign scene", shotId: () => ctx.shotId, sceneId: () => foreignSceneId },
      { name: "cross-project shot", shotId: () => foreignProjectShotId, sceneId: () => foreignProjectSceneId },
    );
    for (const tc of cases) {
      const res = await callPrompt(ctx.projectId, ctx.planId, tc.sceneId(), tc.shotId(), ctx.cookie);
      assert.equal(res.status, 404, `${tc.name} must be a 404`);
      assert.match(res.body.error.message, /shot was not found|scene was not found/i);
    }
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Prerequisite failures: no provider calls, no writes
// ---------------------------------------------------------------------------

test("C7.6 Prompt - a plan with no episode is a 404", async () => {
  const ctx = await setupPromptScenario();
  try {
    const foreignEpisode = seedEpisode(ctx.stores, randomUUID(), "Nowhere", 1);
    const sceneId = seedScene(ctx.stores, foreignEpisode, "S", "D", 1);
    const shotId = seedShot(ctx.stores, sceneId, 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { plan: { story: MOZYTOON_STORY } });
    const res = await callPrompt(ctx.projectId, ctx.planId, sceneId, shotId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.shots.get(shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - an episode from another project is a 404", async () => {
  const ctx = await setupPromptScenario();
  try {
    const otherCookie = await userSession(ctx.stores, "other@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Other Project");
    const foreignEpisodeId = seedEpisode(ctx.stores, otherProjectId, "Foreign", 1);
    const sceneId = seedScene(ctx.stores, foreignEpisodeId, "S", "D", 1);
    const shotId = seedShot(ctx.stores, sceneId, 1);
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { story: MOZYTOON_STORY, episodeId: foreignEpisodeId },
    });
    const res = await callPrompt(ctx.projectId, ctx.planId, sceneId, shotId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 0);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - missing story is a 400 and writes nothing", async () => {
  const ctx = await setupPromptScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const sceneId = seedScene(ctx.stores, episodeId, "S", "D", 1);
    const shotId = seedShot(ctx.stores, sceneId, 1);
    seedScriptVersion(ctx.stores, episodeId, 1, validScriptText());
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
      plan: { userNote: "no story here", episodeId },
    });
    const res = await callPrompt(ctx.projectId, ctx.planId, sceneId, shotId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /story/i);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.stores.shots.get(shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - missing script is a 400 and corrupted script is a 400", async () => {
  const invalidContents = [null, "this is not json at all", JSON.stringify({ title: 42, dialogue: [] })];
  for (const [i, content] of invalidContents.entries()) {
    const ctx = await setupPromptScenario();
    try {
      const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
      const sceneId = seedScene(ctx.stores, episodeId, "S", "D", 1);
      const shotId = seedShot(ctx.stores, sceneId, 1);
      await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
        plan: { story: MOZYTOON_STORY, episodeId },
      });
      if (content !== null) seedScriptVersion(ctx.stores, episodeId, 1, content);
      const res = await callPrompt(ctx.projectId, ctx.planId, sceneId, shotId, ctx.cookie);
      assert.equal(res.status, 400, `case ${i} must be a 400`);
      assert.match(res.body.error.message, /script/i);
      assert.equal(ctx.calls.length, 0, `case ${i} must not call the provider`);
      assert.equal(ctx.stores.shots.get(shotId)!.prompt ?? null, null, `case ${i} must not write`);
    } finally {
      teardownDb();
    }
  }
});

test("C7.6 Prompt - an explicitly referenced missing or cross-episode script is a 404 without fallback", async () => {
  const ctx = await setupPromptScenario();
  try {
    const episodeId = seedEpisode(ctx.stores, ctx.projectId, "Pilot", 1);
    const otherEpisodeId = seedEpisode(ctx.stores, ctx.projectId, "Other", 2);
    const foreignScriptId = seedScriptVersion(ctx.stores, otherEpisodeId, 1, validScriptText());
    for (const scriptVersionId of [randomUUID(), foreignScriptId]) {
      const sceneId = seedScene(ctx.stores, episodeId, "S", "D", 1);
      const shotId = seedShot(ctx.stores, sceneId, 1);
      await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, {
        plan: { story: MOZYTOON_STORY, episodeId, scriptVersionId },
      });
      const res = await callPrompt(ctx.projectId, ctx.planId, sceneId, shotId, ctx.cookie);
      assert.equal(res.status, 404);
      assert.match(res.body.error.message, /script version/i);
    }
    assert.equal(ctx.calls.length, 0);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - a scene of another episode in the same project is a 404", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    const otherEpisodeId = seedEpisode(ctx.stores, ctx.projectId, "Episode 2", 2);
    const foreignSceneId = seedScene(ctx.stores, otherEpisodeId, "Foreign scene", "D", 1);
    const foreignShotId = seedShot(ctx.stores, foreignSceneId, 1);
    const res = await callPrompt(ctx.projectId, ctx.planId, foreignSceneId, foreignShotId, ctx.cookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - only planning-state plans may generate prompts (409)", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    await patchPlan(ctx.cookie, ctx.projectId, ctx.planId, { status: "ready_for_review" });
    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONFLICT");
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - no eligible text model yields 400 without generateText calls", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    ctx.stores.aiProviders.clear();
    ctx.stores.aiModels.clear();
    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /text model/i);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7. Provider failures are sanitized
// ---------------------------------------------------------------------------

test("C7.6 Prompt - provider failure surfaces as 502 and preserves the existing prompt", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    const first = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(first.status, 200);
    const existingPrompt = first.body.data!.shot.prompt as string;

    ctx.state.respond = () => {
      throw new ProviderError("upstream exploded", { provider: "mock-text" });
    };
    const second = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(second.status, 502);
    assert.equal(second.body.error.code, "BAD_GATEWAY");
    assert.match(second.body.error.message, /Prompt generation failed/);
    assert.match(second.body.error.message, /upstream exploded/);
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt, existingPrompt);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.deepEqual(payload.promptedShotIds, [ctx.shotId]);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - unexpected (non-ProviderError) failures are collapsed to a generic message", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    ctx.state.respond = () => {
      throw new Error("internal path /var/secret with credentials sk-abc123");
    };
    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 502);
    assert.equal(
      res.body.error.message,
      "Prompt generation failed due to an unexpected provider error.",
    );
    assert.ok(!res.body.error.message.includes("sk-abc123"));
    assert.ok(!res.body.error.message.includes("/var/secret"));
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8. Malformed JSON and schema-invalid outputs → 502 without writes
// ---------------------------------------------------------------------------

test("C7.6 Prompt - malformed JSON output fails with 502 and writes nothing", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    ctx.state.respond = () => "Here is your prompt, unfortunately [[ broken";
    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, "BAD_GATEWAY");
    assert.equal(ctx.calls.length, 2); // script + failed prompt call
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null);
    const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
    assert.equal(payload.promptedShotIds, undefined);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - schema-invalid outputs fail with 502 and write nothing", async () => {
  const invalidOutputs: string[] = [
    JSON.stringify({}),
    JSON.stringify({ prompt: "" }),
    JSON.stringify({ prompt: "   " }),
    JSON.stringify({ prompt: 42 }),
    JSON.stringify({ prompt: "p".repeat(2001) }),
    JSON.stringify({ prompts: ["wrong shape"] }),
    "just a bare string, not an object",
  ];
  for (const [i, output] of invalidOutputs.entries()) {
    const ctx = await setupPromptScenarioWithShot();
    try {
      ctx.state.respond = () => output;
      const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
      assert.equal(res.status, 502, `case ${i} should be a 502`);
      assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null, `case ${i} must not write`);
    } finally {
      teardownDb();
    }
  }
});

// ---------------------------------------------------------------------------
// 9. Unknown output keys are stripped before persistence
// ---------------------------------------------------------------------------

test("C7.6 Prompt - unknown AI-output keys are stripped by Zod before persistence", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    ctx.state.respond = () =>
      JSON.stringify({
        prompt: "A clean media prompt for the shot.",
        negativePrompt: "blurry, low quality",
        shotId: "ai-assigned-id",
        orderIndex: 99,
      });
    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
    assert.equal(res.status, 200);
    const row = ctx.stores.shots.get(ctx.shotId)!;
    assert.equal(row.prompt, "A clean media prompt for the shot.");
    assert.notEqual(row.id, "ai-assigned-id");
    assert.equal(row.orderIndex, 1); // service-owned, untouched by the AI
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 10. Prompt builder unit test — context embedded, layer rules enforced
// ---------------------------------------------------------------------------

test("C7.6 Prompt - buildMediaPrompt embeds story/script/scene/shot and respects layer boundaries", () => {
  const built = buildMediaPrompt({
    plan: {
      request: MOZYTOON_REQUEST,
      targetDurationSeconds: 30,
      preferences: { audience: "kids" },
    },
    story: MOZYTOON_STORY,
    script: validScript(),
    scene: { name: "Gray Morning", description: "Mozy wakes to a colorless Toonville." },
    shot: {
      purpose: "Establish the town",
      shotType: "wide",
      framing: "full shot",
      cameraMovement: "slow pan",
      cameraAngle: "eye level",
      actionDescription: "Mozy looks out over the gray streets.",
      visualDescription: "A desaturated town.",
      transition: "cut to",
      duration: 8,
      dialogue: "Mimi, where did all the colors go?",
    },
  });

  assert.ok(built.userPrompt.includes(MOZYTOON_REQUEST));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.title));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.learningObjective));
  assert.ok(built.userPrompt.includes("Mimi, where did all the colors go?"));
  assert.ok(built.userPrompt.includes("Gray Morning"));
  assert.ok(built.userPrompt.includes("Purpose: Establish the town"));
  assert.ok(built.userPrompt.includes("Shot type: wide"));
  assert.ok(built.userPrompt.includes("Duration: 8 seconds"));
  assert.ok(built.userPrompt.includes("read-only reference"));
  assert.ok(built.userPrompt.includes("Target duration: about 30 seconds"));
  assert.ok(built.userPrompt.includes(JSON.stringify({ audience: "kids" })));
  assert.ok(built.userPrompt.includes('"prompt"'));

  assert.ok(built.systemPrompt.includes("ONE media-generation prompt"));
  assert.ok(built.systemPrompt.includes("Describe ONLY this shot"));
  assert.ok(built.systemPrompt.includes("do NOT rewrite, extend, or add dialogue"));
  assert.ok(built.systemPrompt.includes("Do NOT include identifiers, order indexes"));
  assert.ok(built.systemPrompt.includes("negative prompts"));
  assert.ok(built.systemPrompt.includes("EXACTLY one JSON object"));
  assert.ok(built.systemPrompt.includes("Do NOT wrap the JSON in markdown code fences"));
  assert.ok(built.systemPrompt.includes("Do not add story or educational content"));

  // A shot with all-null fields still produces a usable prompt.
  const sparse = buildMediaPrompt({
    plan: { request: MOZYTOON_REQUEST, targetDurationSeconds: null, preferences: null },
    story: MOZYTOON_STORY,
    script: validScript(),
    scene: { name: "Gray Morning", description: null },
    shot: {
      purpose: null, shotType: null, framing: null, cameraMovement: null, cameraAngle: null,
      actionDescription: null, visualDescription: null, transition: null, duration: null, dialogue: null,
    },
  });
  assert.ok(sparse.userPrompt.includes("no planned details yet"));
});

// ---------------------------------------------------------------------------
// 11. JSON extraction + parse unit tests
// ---------------------------------------------------------------------------

test("C7.6 Prompt - extractPromptJsonObject tolerates fences and prose but rejects non-objects", () => {
  const object = { prompt: "A shot." };
  assert.deepEqual(extractPromptJsonObject(JSON.stringify(object)), object);
  assert.deepEqual(extractPromptJsonObject("```json\n" + JSON.stringify(object) + "\n```"), object);
  assert.deepEqual(
    extractPromptJsonObject("Sure! Here it is:\n" + JSON.stringify(object) + "\nDone!"),
    object,
  );
  assert.throws(
    () => extractPromptJsonObject("not json at all"),
    (err: unknown) => {
      assert.ok(err instanceof PromptGenerationError);
      assert.equal((err as PromptGenerationError).status, 502);
      return true;
    },
  );
  assert.throws(() => extractPromptJsonObject("[1, 2, 3]"), PromptGenerationError);
  assert.throws(() => extractPromptJsonObject('"just a string"'), PromptGenerationError);
});

test("C7.6 Prompt - parsePromptResponse validates the contract and strips unknown keys", () => {
  assert.equal(
    parsePromptResponse(JSON.stringify({ prompt: "  A prompt.  ", extra: "stripped" })),
    "A prompt.",
  );
  assert.throws(() => parsePromptResponse("{ broken"), PromptGenerationError);
  assert.throws(() => parsePromptResponse(JSON.stringify({ prompt: "" })), PromptGenerationError);
  assert.throws(
    () => parsePromptResponse(JSON.stringify({ prompt: "p".repeat(2001) })),
    PromptGenerationError,
  );
});

// ---------------------------------------------------------------------------
// 12. Repeated generation is deterministic under the tracking rules
// ---------------------------------------------------------------------------

test("C7.6 Prompt - repeated generation follows the tracking rules deterministically", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    // The other shot is untracked with a null prompt: generatable.
    const seenPrompts: string[] = [];
    for (let round = 0; round < 3; round++) {
      const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, ctx.cookie);
      assert.equal(res.status, 200);
      seenPrompts.push(res.body.data!.shot.prompt as string);
      const payload = (ctx.stores.productionPlans.get(ctx.planId)!.plan ?? {}) as Record<string, unknown>;
      assert.deepEqual(payload.promptedShotIds, [ctx.shotId]);
      // The sibling shot stays untouched and untracked.
      assert.equal(ctx.stores.shots.get(ctx.otherShotId)!.prompt ?? null, null);
      assert.equal(ctx.stores.shotVersions.size, 0);
      assert.equal(ctx.stores.aiJobs.size, 0);
    }
    for (const prompt of seenPrompts) {
      assert.equal(prompt, seenPrompts[0]); // deterministic mock, tracked overwrite each time
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 13. Cross-user and cross-project isolation
// ---------------------------------------------------------------------------

test("C7.6 Prompt - another user's project is invisible (404, not 403)", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    const otherCookie = await userSession(ctx.stores, "intruder@example.com");
    const res = await callPrompt(ctx.projectId, ctx.planId, ctx.sceneId, ctx.shotId, otherCookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.calls.length, 1); // only the earlier C7.3 script call
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});

test("C7.6 Prompt - plan must belong to the requested project (404)", async () => {
  const ctx = await setupPromptScenarioWithShot();
  try {
    const otherCookie = await userSession(ctx.stores, "second@example.com");
    const otherProjectId = await seedProject(ctx.stores, otherCookie, "Second Project");
    const res = await callPrompt(otherProjectId, ctx.planId, ctx.sceneId, ctx.shotId, otherCookie);
    assert.equal(res.status, 404);
    assert.equal(ctx.stores.shots.get(ctx.shotId)!.prompt ?? null, null);
  } finally {
    teardownDb();
  }
});
