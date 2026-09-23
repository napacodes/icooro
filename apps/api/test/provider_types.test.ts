/**
 * C6.7.1 — Provider Architecture Foundation tests.
 *
 * This is the *foundation* layer only. It verifies the pieces the later
 * OpenAI / Gemini / custom adapters and the capability-routing layer will
 * build on:
 *
 *   - the provider-type catalog describes exactly the four intended types
 *     (openai, google_gemini, custom_openai_compatible, chatfire) and
 *     nothing else, with ChatFire as one optional type — not the centre
 *   - capability validation is explicit and enumerates text/image/video/
 *     audio/vision, with vision recognised as a recognition-only capability
 *   - reserved types (adapter not implemented yet) can be listed but cannot
 *     be configured with credentials or used
 *   - a provider record resolves to a *record-configured* adapter instance,
 *     never to a shared global singleton carrying another record's key
 *   - the capability lookup answers "enabled model for capability X and job
 *     type Y" correctly, honouring enabled flags, capability match and job
 *     type constraints
 *   - ChatFire still works end-to-end through the abstraction (regression)
 *
 * No real external API is contacted anywhere in this file: globalThis.fetch
 * is stubbed wherever a request would otherwise leave the process.
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { setDb } from "../src/db/index.js";
import { app } from "../src/index.js";
import {
  GENERATION_CAPABILITIES,
  JOB_TYPE_CAPABILITY,
  PROVIDER_CAPABILITIES,
  PROVIDER_TYPES,
  describeProviderType,
  isProviderType,
} from "@icooro/shared";
import {
  capabilitiesForType,
  isAdaptableProviderType,
  isKnownProviderType,
  providerTypeLabel,
  providerTypeNotAdaptableReason,
  listProviderTypes,
} from "../src/providers/types_catalog.js";
import {
  findAdaptersForCapability,
  findModelsForCapability,
  hasModelForCapability,
  normalizeJobTypes,
} from "../src/providers/capabilities.js";
import {
  getAdapterFactory,
  isConfigurableAdapterType,
  isKnownAdapterType,
  listAdapterTypes,
  resolveAdapter,
  resolveVideoProvider,
} from "../src/providers/factory.js";
import { providerRegistry } from "../src/providers/registry.js";
import { providerSecretStore } from "../src/providers/secrets.js";
import { chatfireVideoProvider } from "../src/providers/chatfire.js";
import type { ChatFireVideoProvider } from "../src/providers/chatfire.js";

// ---------------------------------------------------------------------------
// In-memory fake DB (same shape as provider_config.test.ts)
// ---------------------------------------------------------------------------

interface Stores {
  users: Map<string, Record<string, unknown>>;
  sessions: Map<string, Record<string, unknown>>;
  projects: Map<string, Record<string, unknown>>;
  aiProviders: Map<string, Record<string, unknown>>;
  aiModels: Map<string, Record<string, unknown>>;
  aiJobs: Map<string, Record<string, unknown>>;
}

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
    if (name === "ai_providers") return stores.aiProviders;
    if (name === "ai_models") return stores.aiModels;
    if (name === "ai_jobs") return stores.aiJobs;
    throw new Error(`fake db: unknown table ${name}`);
  }

  const ops = {
    select(projection?: Record<string, unknown>) {
      const from = (table: unknown) => {
        const store = storeFor(table);
        const all = () => Array.from(store.values()).map((r) => ({ ...r }));
        const filtered = (cond: unknown) => {
          const terms = walkPredicate(cond);
          return all().filter((r) => rowMatches(r, terms));
        };
        const tail = (rows: Array<Record<string, unknown>>) => ({
          orderBy: () => Promise.resolve(rows.map((r) => projectRow(projection, r))),
          then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(rows.map((r) => projectRow(projection, r))).then(resolve, reject),
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
  };

  return {
    select: ops.select,
    insert: ops.insert,
    update: ops.update,
    delete: ops.delete,
    __stores: stores,
  };
}

function projectRow(projection: Record<string, unknown> | undefined, row: Record<string, unknown>) {
  if (!projection) return { ...row };
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
    aiProviders: new Map(),
    aiModels: new Map(),
    aiJobs: new Map(),
  };
  setDb(makeFakeDb(stores));
  return stores;
}

function teardownDb() {
  setDb(null as any);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function jsonRequest(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const isBodyless =
    init.method === undefined || init.method === "GET" || init.method === "HEAD";
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

async function adminSession(stores: Stores, email = "admin671@example.com") {
  const res = await jsonRequest("/api/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "longenoughpassword", name: "Admin" }),
  });
  assert.equal(res.status, 201);
  const cookie = readSetCookie(res)!;
  for (const u of stores.users.values()) {
    if (u.email === email) u.role = "admin";
  }
  return `${cookie.name}=${cookie.value}`;
}

// ---------------------------------------------------------------------------
// 1. Provider type catalog
// ---------------------------------------------------------------------------

const EXPECTED_TYPES = [
  "openai",
  "google_gemini",
  "custom_openai_compatible",
  "chatfire",
];

test("C6.7.1 Catalog - the four intended provider types exist, and only these", () => {
  const types = listProviderTypes();
  assert.equal(types.length, 4, "exactly four provider types");
  assert.deepEqual(
    types.map((t) => t.providerType).sort(),
    [...EXPECTED_TYPES].sort(),
  );

  for (const expected of EXPECTED_TYPES) {
    assert.ok(isProviderType(expected), `${expected} must be a known provider type`);
    assert.ok(isKnownProviderType(expected));
    assert.ok(describeProviderType(expected), `${expected} must have a descriptor`);
  }

  // Unknown types are rejected — this is what provider validation leans on.
  assert.equal(isProviderType("chatfire-pro"), false);
  assert.equal(isProviderType("freesllmapi"), false);
  assert.equal(isKnownProviderType("anything-else"), false);
});

test("C6.7.1 Catalog - ChatFire is one optional provider type, not the centre", () => {
  const chatfire = describeProviderType("chatfire");
  assert.ok(chatfire, "chatfire must be in the catalog");
  assert.equal(chatfire!.name, "ChatFire");
  assert.deepEqual([...chatfire!.capabilities], ["video"]);
  assert.equal(chatfire!.adapterAvailable, true, "chatfire is the only adaptable type today");

  // ChatFire is a peer of the other three, not a special case.
  assert.equal(listProviderTypes().filter((t) => t.providerType === "chatfire").length, 1);
  assert.ok(
    listProviderTypes().some((t) => t.providerType === "openai"),
    "openai must sit alongside chatfire in the same catalog",
  );
});

test("C6.7.1 Catalog - reserved types are listed but marked unavailable", () => {
  const reserved = ["openai", "google_gemini", "custom_openai_compatible"];
  for (const type of reserved) {
    const descriptor = describeProviderType(type)!;
    assert.equal(
      descriptor.adapterAvailable,
      false,
      `${type} must be reserved (adapter not implemented yet)`,
    );
    assert.equal(isAdaptableProviderType(type), false);
    assert.ok(isKnownProviderType(type), `${type} is still a known architecture type`);
    assert.ok(providerTypeNotAdaptableReason(type), `${type} must have an unusable reason`);
  }

  assert.equal(providerTypeNotAdaptableReason("chatfire"), null);
  assert.ok(providerTypeNotAdaptableReason("nope")!.includes("Unknown provider type"));
});

test("C6.7.1 Catalog - type matching is case-insensitive and labels unknown types", () => {
  assert.ok(isKnownProviderType("OpenAI"));
  assert.ok(isKnownProviderType("GOOGLE_GEMINI"));
  assert.equal(capabilitiesForType("Google_Gemini").length, 5);
  assert.equal(providerTypeLabel("openai"), "OpenAI");
  assert.equal(providerTypeLabel("not-a-type"), "not-a-type");
});

test("C6.7.1 Catalog - capabilities are a subset of the documented set", () => {
  for (const descriptor of PROVIDER_TYPES) {
    for (const capability of descriptor.capabilities) {
      assert.ok(
        PROVIDER_CAPABILITIES.includes(capability),
        `${descriptor.providerType} declares unknown capability "${capability}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Capability validation
// ---------------------------------------------------------------------------

test("C6.7.1 Capabilities - the five explicit capabilities are declared", () => {
  assert.deepEqual([...PROVIDER_CAPABILITIES].sort(), ["audio", "image", "text", "video", "vision"]);
  assert.ok(PROVIDER_CAPABILITIES.includes("vision"), "vision is a first-class capability");
  assert.equal(PROVIDER_CAPABILITIES.includes("reasoning" as never), false);
});

test("C6.7.1 Capabilities - generation job types map onto generation capabilities", () => {
  for (const jobType of Object.keys(JOB_TYPE_CAPABILITY)) {
    const capability = JOB_TYPE_CAPABILITY[jobType as keyof typeof JOB_TYPE_CAPABILITY];
    assert.ok(GENERATION_CAPABILITIES.includes(capability));
    assert.notEqual(capability, "vision", "no generation job type targets the vision capability");
  }
  assert.equal(JOB_TYPE_CAPABILITY["text-to-video"], "video");
  assert.equal(JOB_TYPE_CAPABILITY["text-to-image"], "image");
  assert.equal(JOB_TYPE_CAPABILITY["text-to-audio"], "audio");
});

test("C6.7.1 Capabilities - normalizeJobTypes treats a missing list as 'any job type'", () => {
  assert.equal(normalizeJobTypes(null), null);
  assert.equal(normalizeJobTypes(undefined), null);
  assert.equal(normalizeJobTypes([]), null, "an empty list means no constraint");
  assert.deepEqual(normalizeJobTypes(["text-to-video"]), ["text-to-video"]);
  assert.deepEqual(normalizeJobTypes(["text-to-video", 7, {}]), ["text-to-video"]);
});

// ---------------------------------------------------------------------------
// 3. Adapter factory: record-configured instances, no credential cross-talk
// ---------------------------------------------------------------------------

const KEY_A = "sk-provider-a-key-111122223333";
const KEY_B = "sk-provider-b-key-444455556666";

function recordFor(providerType: string, apiKey: string, baseUrl = "https://api.example.test") {
  return {
    providerType,
    baseUrl,
    apiKeySecret: providerSecretStore.seal(apiKey),
  };
}

test("C6.7.1 Factory - chatfire is registered as a configurable adapter type", () => {
  const types = listAdapterTypes();
  const chatfire = types.find((t) => t.providerType === "chatfire");
  assert.ok(chatfire, "chatfire must be a registered adapter type");
  assert.deepEqual([...chatfire!.capabilities], ["video"]);

  assert.ok(getAdapterFactory("chatfire"));
  assert.ok(isKnownAdapterType("chatfire"));
  assert.ok(isConfigurableAdapterType("chatfire"));
  assert.equal(isConfigurableAdapterType("openai"), false, "openai has no adapter yet");
  assert.equal(getAdapterFactory("openai"), undefined);
});

test("C6.7.1 Factory - two provider records produce two independent instances", () => {
  const a = resolveVideoProvider(recordFor("chatfire", KEY_A, "https://a.example.test"));
  const b = resolveVideoProvider(recordFor("chatfire", KEY_B, "https://b.example.test"));

  assert.ok(a);
  assert.ok(b);
  assert.notStrictEqual(a, b, "each record must get its own configured instance");
  assert.notStrictEqual(a, chatfireVideoProvider, "no global singleton is reused");
  assert.notStrictEqual(b, chatfireVideoProvider);
});

test("C6.7.1 Factory - each record's instance uses only its own credentials", async () => {
  // ChatFireVideoProvider captures globalThis.fetch at construction time, so
  // the stub must be in place *before* the records are resolved. This keeps
  // the test fully offline.
  const calls: Array<{ url: string; auth: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: (init?.headers as Record<string, string>)?.Authorization ?? "",
    });
    return new Response(JSON.stringify({ id: "task-1", status: "QUEUED" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const a = resolveVideoProvider(recordFor("chatfire", KEY_A, "https://a.example.test"));
    const b = resolveVideoProvider(recordFor("chatfire", KEY_B, "https://b.example.test"));
    assert.ok(a && b);

    await a!.createJob({ prompt: "prompt a", modelId: "model-a" });
    await b!.createJob({ prompt: "prompt b", modelId: "model-b" });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "https://a.example.test/volcengine/api/v3/contents/generations/tasks");
    assert.equal(calls[0]!.auth, `Bearer ${KEY_A}`);
    assert.equal(calls[1]!.url, "https://b.example.test/volcengine/api/v3/contents/generations/tasks");
    assert.equal(calls[1]!.auth, `Bearer ${KEY_B}`, "record B must never see record A's key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C6.7.1 Factory - a record without a key still resolves and reports the gap", () => {
  const adapter = resolveVideoProvider({
    providerType: "chatfire",
    baseUrl: "https://api.chatfire.site",
    apiKeySecret: null,
  });
  assert.ok(adapter, "a keyless record still resolves — the adapter owns the error");

  // The adapter surfaces a clear configuration error rather than a crash.
  return assert.rejects(
    () => adapter!.createJob({ prompt: "x", modelId: "m" }),
    /API key is not configured/,
  );
});

test("C6.7.1 Factory - resolveAdapter honours capability and rejects unknown types", () => {
  assert.ok(resolveAdapter(recordFor("chatfire", KEY_A), "video"));
  assert.equal(
    resolveAdapter(recordFor("chatfire", KEY_A), "image"),
    undefined,
    "chatfire declares video only",
  );
  assert.equal(
    resolveAdapter({ providerType: "openai", baseUrl: null, apiKeySecret: null }, "text"),
    undefined,
    "openai has no adapter implementation yet",
  );
  assert.equal(
    resolveAdapter({ providerType: "mystery", baseUrl: null, apiKeySecret: null }, "video"),
    undefined,
  );
});

test("C6.7.1 Factory - registry singletons stay available for internal adapters", () => {
  // The C5 mock provider is a registry singleton and must still resolve,
  // including through the record-aware path.
  assert.ok(providerRegistry.get("mock"));
  assert.ok(resolveAdapter({ providerType: "mock" }, "video"));
});

// ---------------------------------------------------------------------------
// 4. Capability lookup foundation
// ---------------------------------------------------------------------------

function seedProviderRow(stores: Stores, providerType: string, apiKey = KEY_A): string {
  const id = randomUUID();
  stores.aiProviders.set(id, {
    id,
    name: `Provider ${id.slice(0, 8)}`,
    providerType,
    enabled: true,
    baseUrl: "https://api.example.test",
    apiKeySecret: apiKey ? providerSecretStore.seal(apiKey) : null,
    config: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function seedModelRow(
  stores: Stores,
  providerId: string,
  capability: string,
  jobTypes: string[] | null,
  enabled = true,
): string {
  const id = randomUUID();
  stores.aiModels.set(id, {
    id,
    providerId,
    name: `Model ${id.slice(0, 8)}`,
    modelId: `ext-${id.slice(0, 8)}`,
    capability,
    jobTypes,
    enabled,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

test("C6.7.1 Lookup - finds an enabled model for a capability and job type", async () => {
  const stores = setupDb();
  try {
    const db = makeFakeDb(stores);
    const providerId = seedProviderRow(stores, "chatfire");
    seedModelRow(stores, providerId, "video", ["text-to-video"]);

    const models = await findModelsForCapability({
      db,
      capability: "video",
      jobType: "text-to-video",
    });
    assert.equal(models.length, 1);
    assert.equal(models[0]!.capability, "video");
    assert.equal(models[0]!.providerType, "chatfire");
    assert.equal(models[0]!.providerEnabled, true);

    assert.equal(await hasModelForCapability({ db, capability: "video" }), true);
    assert.equal(await hasModelForCapability({ db, capability: "image" }), false);
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Lookup - a model with no job types serves any job type", async () => {
  const stores = setupDb();
  try {
    const db = makeFakeDb(stores);
    const providerId = seedProviderRow(stores, "chatfire");
    seedModelRow(stores, providerId, "video", null);

    const models = await findModelsForCapability({
      db,
      capability: "video",
      jobType: "text-to-video",
    });
    assert.equal(models.length, 1, "null jobTypes means any job type");
    assert.equal(
      (await findModelsForCapability({ db, capability: "video", jobType: "text-to-audio" })).length,
      1,
    );
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Lookup - a model whose job types do not match is excluded", async () => {
  const stores = setupDb();
  try {
    const db = makeFakeDb(stores);
    const providerId = seedProviderRow(stores, "chatfire");
    seedModelRow(stores, providerId, "video", ["text-to-video"]);

    assert.equal(
      (await findModelsForCapability({ db, capability: "video", jobType: "text-to-audio" })).length,
      0,
    );
    assert.equal((await findModelsForCapability({ db, capability: "video" })).length, 1);
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Lookup - disabled models and disabled providers are hidden", async () => {
  const stores = setupDb();
  try {
    const db = makeFakeDb(stores);

    const onProvider = seedProviderRow(stores, "chatfire");
    const offProvider = seedProviderRow(stores, "chatfire");
    stores.aiProviders.get(offProvider)!.enabled = false;

    seedModelRow(stores, onProvider, "video", ["text-to-video"], false);
    seedModelRow(stores, offProvider, "video", ["text-to-video"], true);

    assert.equal(
      (await findModelsForCapability({ db, capability: "video" })).length,
      0,
      "disabled model + disabled-provider model must both be excluded",
    );

    // Re-enable the model on the healthy provider.
    for (const model of stores.aiModels.values()) {
      if (model.providerId === onProvider) model.enabled = true;
    }
    assert.equal((await findModelsForCapability({ db, capability: "video" })).length, 1);
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Lookup - reserved provider types yield no usable adapter", async () => {
  const stores = setupDb();
  try {
    const db = makeFakeDb(stores);
    // An admin could not have created this (validation blocks it), but the
    // lookup must still never hand back an adapter for a type with no
    // implementation.
    const providerId = seedProviderRow(stores, "openai");
    seedModelRow(stores, providerId, "text", null);

    const models = await findModelsForCapability({ db, capability: "text" });
    assert.equal(models.length, 1, "the configured model is still discoverable");

    const adapters = await findAdaptersForCapability({ db, capability: "text" });
    assert.equal(adapters.length, 0, "but no adapter instance can be built for it yet");
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Lookup - findAdaptersForCapability returns a ready instance", async () => {
  const stores = setupDb();
  const originalFetch = globalThis.fetch;
  // Stub first: ChatFireVideoProvider binds globalThis.fetch on construction.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: "task-x", status: "QUEUED" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const db = makeFakeDb(stores);
    const providerId = seedProviderRow(stores, "chatfire", KEY_A);
    seedModelRow(stores, providerId, "video", ["text-to-video"]);

    const candidates = await findAdaptersForCapability({
      db,
      capability: "video",
      jobType: "text-to-video",
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.model.providerType, "chatfire");
    assert.equal(candidates[0]!.adapter.providerType, "chatfire");

    const result = await (candidates[0]!.adapter as ChatFireVideoProvider).createJob({
      prompt: "p",
      modelId: candidates[0]!.model.modelId,
    });
    assert.equal(result.externalJobId, "task-x");
  } finally {
    globalThis.fetch = originalFetch;
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Control Plane: provider type catalog endpoint + reserved type guard
// ---------------------------------------------------------------------------

test("C6.7.1 Admin - /admin/provider-types lists the full architecture", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const res = await jsonRequest("/api/v1/admin/provider-types", { cookie });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ providerType: string; adapterAvailable: boolean }> };
    assert.equal(body.data.length, 4);
    assert.deepEqual(
      body.data.map((t) => t.providerType).sort(),
      [...EXPECTED_TYPES].sort(),
    );
    assert.equal(body.data.filter((t) => t.adapterAvailable).length, 1, "only chatfire today");
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Admin - a reserved provider type cannot be configured", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const res = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "OpenAI", providerType: "openai", apiKey: KEY_A }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /no adapter implementation yet/);
    assert.equal(stores.aiProviders.size, 0, "no provider row may be persisted");
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Admin - a truly unknown provider type is rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const res = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "Mystery", providerType: "freesllmapi" }),
    });
    assert.equal(res.status, 400);
    assert.match(
      ((await res.json()) as { error: { message: string } }).error.message,
      /not part of the Icooro provider architecture/,
    );
  } finally {
    teardownDb();
  }
});

test("C6.7.1 Admin - a model can declare the vision capability", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "ChatFire Vision", providerType: "chatfire", apiKey: KEY_A }),
    });
    assert.equal(provider.status, 201);
    const providerId = ((await provider.json()) as { data: any }).data.id;

    const model = await jsonRequest("/api/v1/admin/models", {
      method: "POST",
      cookie,
      body: JSON.stringify({
        providerId,
        name: "Vision Model",
        modelId: "vision-1",
        capability: "vision",
      }),
    });
    assert.equal(model.status, 201);
    assert.equal(((await model.json()) as { data: any }).data.capability, "vision");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. ChatFire regression through the abstraction
// ---------------------------------------------------------------------------

test("C6.7.1 ChatFire regression - the C5 singleton path still resolves video", () => {
  assert.equal(chatfireVideoProvider.providerType, "chatfire");
  assert.deepEqual([...chatfireVideoProvider.capabilities], ["video"]);

  // Pre-C6.3 code resolved by type from the registry; that must keep working.
  const fromRegistry = providerRegistry.getVideoProvider("chatfire");
  assert.equal(fromRegistry, chatfireVideoProvider);
});

test("C6.7.1 ChatFire regression - the record path reaches the same adapter type", () => {
  const record = recordFor("chatfire", KEY_A);
  const resolved = resolveVideoProvider(record);
  assert.ok(resolved);
  assert.equal(resolved!.providerType, chatfireVideoProvider.providerType);
  assert.equal(resolved!.name, chatfireVideoProvider.name);
});
