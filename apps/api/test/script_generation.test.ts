// ---------------------------------------------------------------------------
// C7.3 — AI Episode / Script Generation (Episode + ScriptVersion)
//
// ProductionPlan → validated Story → generic text provider → structured
// script → NEW ScriptVersion on the plan's episode. All providers here are
// deterministic in-process mocks — NO real OpenAI/Gemini/ChatFire call can
// ever happen (guarded by a global fetch tripwire).
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { setDb } from "../src/db/index.js";
import {
  scriptContractSchema,
  type ScriptContract,
  type StoryContract,
} from "@icooro/shared";
import {
  ScriptGenerationError,
  extractScriptJsonObject,
  parseScriptResponse,
} from "../src/services/script_generation.js";
import { buildScriptPrompt } from "../src/services/script_prompt.js";
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
    scripts: new Map(),
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
    name: "Script model",
    modelId: "mock-script-model-1",
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

async function seedProject(stores: Stores, cookie: string, name = "Script Project"): Promise<string> {
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

/** Plan with a story in its payload (what C7.2 leaves behind), ready for C7.3. */
async function setupScriptScenario(respond: () => string, options: {
  anchoredEpisodeId?: string;
  extraPlanPayload?: Record<string, unknown>;
} = {}) {
  const adapter = installMockTextAdapter(respond);
  const stores = setupDb();
  const cookie = await userSession(stores);
  const projectId = await seedProject(stores, cookie);
  const created = await createPlan(cookie, projectId, {
    targetDurationSeconds: null,
    preferences: { audience: "kids", tone: "playful" },
    ...(options.anchoredEpisodeId ? { episodeId: options.anchoredEpisodeId } : {}),
  });
  assert.equal(created.status, 201);
  const planId = created.body.data!.id;
  await patchPlan(cookie, projectId, planId, {
    plan: { story: MOZYTOON_STORY, ...(options.extraPlanPayload ?? {}) },
  });
  seedTextProviderAndModel(stores);
  return { adapter, stores, cookie, projectId, planId };
}

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

async function withFetchTripwire<T>(fn: () => Promise<T>): Promise<{ result: T; tripwireHits: number }> {
  let tripwireHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    tripwireHits += 1;
    throw new Error("TRIPWIRE: external network call attempted during script generation");
  }) as typeof fetch;
  try {
    return { result: await fn(), tripwireHits };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// 1 + 18. Successful generation — representative Mozytoon request
// ---------------------------------------------------------------------------

test("C7.3 Script - successful generation creates the episode and script version (Mozytoon request)", async () => {
  const { adapter, stores, cookie, projectId, planId } = await setupScriptScenario(() =>
    validScriptText(),
  );
  try {
    const { result, tripwireHits } = await withFetchTripwire(() =>
      generateScript(projectId, planId, cookie),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.error, undefined);
    const data = result.body.data!;

    // The script is structured per the shared contract.
    assert.equal(scriptContractSchema.safeParse(JSON.parse(data.scriptVersion.content)).success, true);
    assert.ok(Array.isArray(JSON.parse(data.scriptVersion.content).dialogue));
    assert.ok(JSON.parse(data.scriptVersion.content).dialogue.length >= 1);
    assert.ok(typeof JSON.parse(data.scriptVersion.content).closingLine.text === "string");

    // An episode was created for this plan, titled from the story.
    assert.equal(stores.episodes.size, 1);
    const [episodeRow] = Array.from(stores.episodes.values());
    assert.equal(episodeRow!.projectId, projectId);
    assert.equal(episodeRow!.title, MOZYTOON_STORY.title);
    assert.equal(episodeRow!.episodeNumber, 1);

    // The script version lives on that episode as version 1.
    assert.equal(stores.scripts.size, 1);
    const [scriptRow] = Array.from(stores.scripts.values());
    assert.equal(scriptRow!.episodeId, episodeRow!.id);
    assert.equal(scriptRow!.version, 1);

    // The response relationships line up with the rows.
    assert.equal(data.episode.id, episodeRow!.id);
    assert.equal(data.scriptVersion.episodeId, episodeRow!.id);
    assert.deepEqual(data.versions, [{ id: scriptRow!.id, version: 1 }]);

    // The plan records only the reference and keeps the story.
    const planRow = stores.productionPlans.get(planId)!;
    const plan = planRow.plan as Record<string, unknown>;
    assert.equal(plan.episodeId, episodeRow!.id);
    assert.equal(plan.scriptVersionId, scriptRow!.id);
    assert.deepEqual(plan.story, MOZYTOON_STORY);
    assert.equal(planRow.status, "planning");

    // The generated request went through the generic provider exactly once,
    // addressed to the routed model, with the story in the prompt.
    assert.equal(adapter.calls.length, 1);
    const call = adapter.calls[0]!;
    assert.equal(call.modelId, "mock-script-model-1");
    assert.ok(call.prompt.includes(MOZYTOON_REQUEST));
    assert.ok(call.prompt.includes(MOZYTOON_STORY.premise));
    assert.ok(call.prompt.includes(MOZYTOON_STORY.learningObjective));
    assert.ok(call.systemPrompt.toLowerCase().includes("json"));

    assert.equal(tripwireHits, 0, "no external network call may be made");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Story required
// ---------------------------------------------------------------------------

test("C7.3 Script - missing story is a clear validation error and writes nothing", async () => {
  const adapter = installMockTextAdapter(() => validScriptText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);
    assert.equal(created.status, 201);
    const planId = created.body.data!.id;
    seedTextProviderAndModel(stores);

    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 400);
    assert.match(body.error!.message, /No story has been generated/);
    assert.match(body.error!.message, /story first/);

    // No episode, no script version, no plan change, no provider call.
    assert.equal(adapter.calls.length, 0);
    assert.equal(stores.episodes.size, 0);
    assert.equal(stores.scripts.size, 0);
    assert.equal(stores.productionPlans.get(planId)!.plan, null);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - a corrupted story in the payload is treated as absent", async () => {
  const adapter = installMockTextAdapter(() => validScriptText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);
    const planId = created.body.data!.id;
    await patchPlan(cookie, projectId, planId, {
      plan: { story: { title: "half a story" } },
    });
    seedTextProviderAndModel(stores);

    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 400);
    assert.match(body.error!.message, /No story has been generated/);
    assert.equal(adapter.calls.length, 0);
    assert.equal(stores.scripts.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 4. Episode association
// ---------------------------------------------------------------------------

test("C7.3 Script - an anchored plan writes the script onto its own episode", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const episodeId = seedEpisode(stores, projectId, "Pilot", 1);
    seedTextProviderAndModel(stores);
    installMockTextAdapter(() => validScriptText());

    const created = await createPlan(cookie, projectId, { episodeId });
    assert.equal(created.status, 201);
    const planId = created.body.data!.id;
    await patchPlan(cookie, projectId, planId, { plan: { story: MOZYTOON_STORY } });

    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 200);

    assert.equal(stores.episodes.size, 1, "no new episode is created when anchored");
    const [scriptRow] = Array.from(stores.scripts.values());
    assert.equal(scriptRow!.episodeId, episodeId);
    assert.equal(body.data!.episode.id, episodeId);
    assert.equal(body.data!.episode.title, "Pilot");
    assert.equal(body.data!.episode.episodeNumber, 1);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - unanchored plans create sequential episodes titled from the story", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedTextProviderAndModel(stores);
    installMockTextAdapter(() => validScriptText());

    const first = await createPlan(cookie, projectId);
    await patchPlan(cookie, projectId, first.body.data!.id, { plan: { story: MOZYTOON_STORY } });
    const gen1 = await generateScript(projectId, first.body.data!.id, cookie);
    assert.equal(gen1.status, 200);
    assert.equal(gen1.body.data!.episode.episodeNumber, 1);
    assert.equal(gen1.body.data!.episode.title, MOZYTOON_STORY.title);

    // A second plan in the same project gets the next free episode slot.
    const second = await createPlan(cookie, projectId);
    await patchPlan(cookie, projectId, second.body.data!.id, { plan: { story: MOZYTOON_STORY } });
    const gen2 = await generateScript(projectId, second.body.data!.id, cookie);
    assert.equal(gen2.status, 200);
    assert.equal(gen2.body.data!.episode.episodeNumber, 2);
    assert.notEqual(gen2.body.data!.episode.id, gen1.body.data!.episode.id);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5-7. Version creation, preservation, regeneration
// ---------------------------------------------------------------------------

test("C7.3 Script - the generated script is a new version with JSON content", async () => {
  const { stores, cookie, projectId, planId } = await setupScriptScenario(() => validScriptText());
  try {
    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 200);

    const [row] = Array.from(stores.scripts.values());
    assert.equal(row!.version, 1);
    const content = JSON.parse(row!.content as string);
    assert.equal(scriptContractSchema.safeParse(content).success, true);
    assert.equal(content.dialogue[0]!.speaker, "Mozy");
    assert.equal(body.data!.scriptVersion.version, 1);
    assert.equal(body.data!.scriptVersion.id, row!.id);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - pre-existing script versions are preserved", async () => {
  const { stores, cookie, projectId, planId } = await setupScriptScenario(() => validScriptText());
  try {
    // A version created before AI generation existed on this episode.
    const episodeId = seedEpisode(stores, projectId, "Pilot", 1);
    const anchored = await createPlan(cookie, projectId, { episodeId });
    await patchPlan(cookie, projectId, anchored.body.data!.id, {
      plan: { story: MOZYTOON_STORY },
    });
    const oldVersionId = seedScriptVersion(stores, episodeId, 1, "the original human script");
    const oldRow = stores.scripts.get(oldVersionId)!;
    const oldUpdatedAt = oldRow.updatedAt;

    const { status, body } = await generateScript(projectId, anchored.body.data!.id, cookie);
    assert.equal(status, 200);
    assert.equal(body.data!.scriptVersion.version, 2);

    // The old version is untouched.
    const after = stores.scripts.get(oldVersionId)!;
    assert.equal(after.content, "the original human script");
    assert.equal(after.version, 1);
    assert.equal(after.updatedAt, oldUpdatedAt);

    // Both versions exist; the new one is the latest.
    assert.equal(stores.scripts.size, 2);
    assert.deepEqual(body.data!.versions, [
      { id: oldVersionId, version: 1 },
      { id: body.data!.scriptVersion.id, version: 2 },
    ]);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - regeneration creates a new version and never destroys the old one", async () => {
  const scenario = await setupScriptScenario(() => validScriptText());
  let { adapter } = scenario;
  const { stores, cookie, projectId, planId } = scenario;
  try {
    const first = await generateScript(projectId, planId, cookie);
    assert.equal(first.status, 200);
    const v1 = first.body.data!.scriptVersion;

    // Swap in a different deterministic script for the regeneration.
    adapter = installMockTextAdapter(() =>
      validScriptText({
        title: "Mozy and the Mixed-Up Rainbow",
        dialogue: [{ speaker: "Mozy", text: "A whole new take!" }],
      }),
    );

    const second = await generateScript(projectId, planId, cookie);
    assert.equal(second.status, 200);
    const v2 = second.body.data!.scriptVersion;

    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.version, 2);
    assert.equal(stores.scripts.size, 2);
    assert.equal((stores.scripts.get(v1.id)!.content as string).includes("Mimi"), true);
    assert.equal(
      JSON.parse(stores.scripts.get(v2.id)!.content as string).title,
      "Mozy and the Mixed-Up Rainbow",
    );

    // The plan now references the newest version; the story is preserved.
    const plan = stores.productionPlans.get(planId)!.plan as Record<string, unknown>;
    assert.equal(plan.scriptVersionId, v2.id);
    assert.equal(plan.episodeId, v2.episodeId);
    assert.deepEqual(plan.story, MOZYTOON_STORY);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8-9. Failure preservation
// ---------------------------------------------------------------------------

test("C7.3 Script - failed regeneration preserves the previous version and plan data", async () => {
  const scenario = await setupScriptScenario(() => validScriptText());
  const { stores, cookie, projectId, planId } = scenario;
  try {
    const first = await generateScript(projectId, planId, cookie);
    assert.equal(first.status, 200);
    const v1 = first.body.data!.scriptVersion;
    const planBefore = structuredClone(stores.productionPlans.get(planId)!.plan);

    // Provider fails on the regeneration attempt.
    installMockTextAdapter(() => {
      throw new ProviderError("upstream rate limited", { provider: "mock-text", statusCode: 429 });
    });

    const failed = await generateScript(projectId, planId, cookie);
    assert.equal(failed.status, 502);
    assert.match(failed.body.error!.message, /Script generation failed/);
    assert.match(failed.body.error!.message, /rate limited/);

    // Exactly one version remains, untouched; plan payload unchanged.
    assert.equal(stores.scripts.size, 1);
    assert.equal(stores.scripts.get(v1.id)!.version, 1);
    assert.deepEqual(stores.productionPlans.get(planId)!.plan, planBefore);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - unrelated ProductionPlan data is preserved by generation", async () => {
  const { stores, cookie, projectId, planId } = await setupScriptScenario(() => validScriptText(), {
    extraPlanPayload: { notes: "keep me", scenes: [{ id: "s1", summary: "later phase" }] },
  });
  try {
    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 200);

    const planRow = stores.productionPlans.get(planId)!;
    const plan = planRow.plan as Record<string, unknown>;
    assert.equal(plan.notes, "keep me");
    assert.deepEqual(plan.scenes, [{ id: "s1", summary: "later phase" }]);
    assert.deepEqual(plan.story, MOZYTOON_STORY);
    assert.ok(plan.episodeId, "episode reference is added");
    assert.ok(plan.scriptVersionId, "script-version reference is added");
    assert.equal(planRow.status, "planning");
    assert.equal(planRow.request, MOZYTOON_REQUEST);
    assert.deepEqual(planRow.preferences, { audience: "kids", tone: "playful" });
    assert.equal(body.data!.plan.notes, "keep me");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 10-13. Output/provider failure modes
// ---------------------------------------------------------------------------

test("C7.3 Script - malformed JSON fails with 502 and writes nothing", async () => {
  const scenario = await setupScriptScenario(() => "not json at all {{{");
  const { adapter, stores, cookie, projectId, planId } = scenario;
  try {
    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 502);
    assert.match(body.error!.message, /valid JSON object/);
    assert.equal(adapter.calls.length, 1, "the attempt reached the provider");
    assert.equal(stores.episodes.size, 0, "no orphan episode");
    assert.equal(stores.scripts.size, 0);
    const plan = stores.productionPlans.get(planId)!.plan as Record<string, unknown>;
    assert.equal(plan.episodeId, undefined);
    assert.deepEqual(plan.story, MOZYTOON_STORY);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - schema-invalid output fails with 502 and writes nothing", async () => {
  const scenario = await setupScriptScenario(() =>
    JSON.stringify({ title: "Half a script", dialogue: [] }),
  );
  const { stores, cookie, projectId, planId } = scenario;
  try {
    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 502);
    assert.match(body.error!.message, /script structure/);
    assert.equal(stores.episodes.size, 0);
    assert.equal(stores.scripts.size, 0);
    assert.deepEqual(
      (stores.productionPlans.get(planId)!.plan as Record<string, unknown>).story,
      MOZYTOON_STORY,
    );
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - provider failure surfaces as 502 and writes nothing", async () => {
  const scenario = await setupScriptScenario(() => {
    throw new ProviderError("upstream exploded", { provider: "mock-text", statusCode: 500 });
  });
  const { stores, cookie, projectId, planId } = scenario;
  try {
    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 502);
    assert.match(body.error!.message, /Script generation failed/);
    assert.equal(stores.episodes.size, 0);
    assert.equal(stores.scripts.size, 0);
    assert.deepEqual(
      (stores.productionPlans.get(planId)!.plan as Record<string, unknown>).story,
      MOZYTOON_STORY,
    );
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - no eligible text model yields 400 without side effects", async () => {
  const adapter = installMockTextAdapter(() => validScriptText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    const created = await createPlan(cookie, projectId);
    const planId = created.body.data!.id;
    await patchPlan(cookie, projectId, planId, { plan: { story: MOZYTOON_STORY } });
    // No ai_providers / ai_models rows seeded on purpose.

    const { status, body } = await generateScript(projectId, planId, cookie);
    assert.equal(status, 400);
    assert.match(body.error!.message, /No enabled text model/);
    assert.equal(adapter.calls.length, 0);
    assert.equal(stores.episodes.size, 0, "no orphan episode may be created");
    assert.equal(stores.scripts.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 14-16. Ownership and state guards
// ---------------------------------------------------------------------------

test("C7.3 Script - another user's project is invisible (404, not 403)", async () => {
  const adapter = installMockTextAdapter(() => validScriptText());
  const stores = setupDb();
  try {
    const ownerCookie = await userSession(stores, "owner@example.com");
    const projectId = await seedProject(stores, ownerCookie);
    const created = await createPlan(ownerCookie, projectId);
    const planId = created.body.data!.id;
    await patchPlan(ownerCookie, projectId, planId, { plan: { story: MOZYTOON_STORY } });
    seedTextProviderAndModel(stores);

    const otherCookie = await userSession(stores, "intruder@example.com");
    const { status, body } = await generateScript(projectId, planId, otherCookie);
    assert.equal(status, 404);
    assert.equal(body.error!.message, "Project not found");
    assert.equal(adapter.calls.length, 0);
    assert.equal(stores.scripts.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - wrong project/episode/plan relationships are 404s", async () => {
  const adapter = installMockTextAdapter(() => validScriptText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectA = await seedProject(stores, cookie, "A");
    const projectB = await seedProject(stores, cookie, "B");
    seedTextProviderAndModel(stores);

    // (a) Plan of project A requested under project B.
    const created = await createPlan(cookie, projectA);
    const planId = created.body.data!.id;
    await patchPlan(cookie, projectA, planId, { plan: { story: MOZYTOON_STORY } });
    const wrongProject = await generateScript(projectB, planId, cookie);
    assert.equal(wrongProject.status, 404);
    assert.equal(wrongProject.body.error!.message, "Production plan not found");

    // (b) Plan payload referencing an episode that belongs to another project.
    const foreignEpisodeId = seedEpisode(stores, projectB, "Foreign", 1);
    const created2 = await createPlan(cookie, projectA);
    const planId2 = created2.body.data!.id;
    await patchPlan(cookie, projectA, planId2, {
      plan: { story: MOZYTOON_STORY, episodeId: foreignEpisodeId },
    });
    const foreignEpisode = await generateScript(projectA, planId2, cookie);
    assert.equal(foreignEpisode.status, 404);
    assert.match(foreignEpisode.body.error!.message, /not found in its project/);

    assert.equal(adapter.calls.length, 0);
    assert.equal(stores.scripts.size, 0);
  } finally {
    teardownDb();
  }
});

test("C7.3 Script - only planning-state plans may generate scripts (409)", async () => {
  const adapter = installMockTextAdapter(() => validScriptText());
  const stores = setupDb();
  try {
    const cookie = await userSession(stores);
    const projectId = await seedProject(stores, cookie);
    seedTextProviderAndModel(stores);
    const created = await createPlan(cookie, projectId);
    const planId = created.body.data!.id;
    await patchPlan(cookie, projectId, planId, { plan: { story: MOZYTOON_STORY } });

    await patchPlan(cookie, projectId, planId, { status: "ready_for_review" });
    const inReview = await generateScript(projectId, planId, cookie);
    assert.equal(inReview.status, 409);
    assert.match(inReview.body.error!.message, /planning/);

    await patchPlan(cookie, projectId, planId, { status: "approved" });
    const approved = await generateScript(projectId, planId, cookie);
    assert.equal(approved.status, 409);

    const second = await createPlan(cookie, projectId);
    const secondId = second.body.data!.id;
    await patchPlan(cookie, projectId, secondId, { plan: { story: MOZYTOON_STORY } });
    await patchPlan(cookie, projectId, secondId, { status: "cancelled" });
    const cancelled = await generateScript(projectId, secondId, cookie);
    assert.equal(cancelled.status, 409);

    assert.equal(adapter.calls.length, 0, "no provider call may happen outside planning");
    assert.equal(stores.episodes.size, 0);
    assert.equal(stores.scripts.size, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// Unit: response parsing and prompt construction
// ---------------------------------------------------------------------------

test("C7.3 Script - extractScriptJsonObject tolerates fences and prose but rejects non-objects", () => {
  const script = validScript();

  assert.deepEqual(extractScriptJsonObject(JSON.stringify(script)), script);
  assert.deepEqual(
    extractScriptJsonObject("```json\n" + JSON.stringify(script, null, 2) + "\n```"),
    script,
  );
  assert.deepEqual(
    extractScriptJsonObject("Here is the script:\n" + JSON.stringify(script) + "\nDone!"),
    script,
  );

  assert.throws(() => extractScriptJsonObject("no json here"), ScriptGenerationError);
  assert.throws(() => extractScriptJsonObject("{ broken"), ScriptGenerationError);
  assert.throws(() => extractScriptJsonObject("[1, 2, 3]"), ScriptGenerationError);
  assert.throws(() => extractScriptJsonObject("null"), ScriptGenerationError);
});

test("C7.3 Script - parseScriptResponse validates the contract and strips unknown keys", () => {
  const parsed = parseScriptResponse(
    JSON.stringify({ ...validScript(), cameraDirections: ["zoom in"], weather: "sunny" }),
  );
  assert.deepEqual(parsed, validScript());
  assert.equal("cameraDirections" in parsed, false);

  assert.throws(() => parseScriptResponse("{ not json"), ScriptGenerationError);
  assert.throws(
    () => parseScriptResponse(JSON.stringify({ ...validScript(), dialogue: [] })),
    ScriptGenerationError,
    "empty dialogue must fail validation",
  );
  assert.throws(
    () => parseScriptResponse(JSON.stringify({ ...validScript(), closingLine: undefined })),
    ScriptGenerationError,
    "missing closing line must fail validation",
  );
  assert.throws(
    () =>
      parseScriptResponse(
        JSON.stringify({ ...validScript(), estimatedDurationSeconds: 7200 }),
      ),
    ScriptGenerationError,
    "durations beyond the contract maximum must fail",
  );
  assert.throws(
    () => parseScriptResponse(JSON.stringify({ ...validScript(), dialogue: [{ speaker: "", text: "hi" }] })),
    ScriptGenerationError,
    "unnamed speakers must fail validation",
  );
});

test("C7.3 Script - buildScriptPrompt embeds story, request, duration and the contract", () => {
  const built = buildScriptPrompt({
    plan: {
      request: MOZYTOON_REQUEST,
      targetDurationSeconds: 30,
      preferences: { audience: "kids" },
    },
    story: MOZYTOON_STORY,
    projectName: "Mozytoon Season 1",
  });

  assert.ok(built.userPrompt.includes(MOZYTOON_REQUEST));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.premise));
  assert.ok(built.userPrompt.includes(MOZYTOON_STORY.learningObjective));
  assert.ok(built.userPrompt.includes("Mozy"));
  assert.ok(built.userPrompt.includes("30 seconds"));
  for (const key of ["title", "objective", "estimatedDurationSeconds", "dialogue", "closingLine"]) {
    assert.ok(built.userPrompt.includes(key), `contract key "${key}" must be requested`);
  }
  // Layer discipline: the system prompt forbids scene/shot planning.
  const system = built.systemPrompt.toLowerCase();
  assert.ok(system.includes("json"));
  assert.ok(system.includes("do not include scenes"));
  assert.ok(system.includes("shot"));
});
