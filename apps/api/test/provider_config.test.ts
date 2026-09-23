/**
 * C6.3 — Database-driven AI Provider + Model configuration tests.
 *
 * Covers:
 *   - Admin authorization on the new provider/model endpoints
 *   - Provider CRUD (create / read / update / delete) with adapter-type validation
 *   - Model CRUD with provider-relationship validation
 *   - API-key redaction: the raw key and the sealed envelope never appear in
 *     any response body, and masked previews are the only thing exposed
 *   - Enable/disable semantics for providers and models
 *   - Safe-delete guards (referenced providers/models cannot be removed)
 *   - Generation selection: enabled providers/models only, and job creation
 *     resolving to the configured provider/model
 *   - ChatFire resolution through a configured provider record (no real
 *     network call — globalThis.fetch is temporarily stubbed)
 *   - Secret store envelope round-trip and masking guarantees
 *
 * No real AI provider is contacted anywhere in this file.
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { setDb } from "../src/db/index.js";
import { app } from "../src/index.js";
import {
  getAdapterFactory,
  isKnownAdapterType,
  listAdapterTypes,
  registerAdapterFactory,
  resolveAdapter,
  resolveVideoProvider,
} from "../src/providers/factory.js";
import {
  hasSecret,
  maskSecret,
  providerSecretStore,
} from "../src/providers/secrets.js";
import { ProviderError } from "../src/providers/types.js";
import type { ChatFireVideoProvider } from "../src/providers/chatfire.js";

// ---------------------------------------------------------------------------
// In-memory fake DB
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

function projectRow(projection: Record<string, unknown> | undefined, row: Record<string, unknown>) {
  if (!projection) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(projection)) {
    out[key] = row[key];
  }
  return out;
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
  // GET/HEAD requests must not carry a body: Node's Request constructor
  // rejects it. Drop the body for those methods (the test authorisation
  // cases pass a placeholder body for every method).
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

async function adminSession(stores: Stores, email = "admin@example.com") {
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

async function userSession(email = "user@example.com") {
  const res = await jsonRequest("/api/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "longenoughpassword", name: "User" }),
  });
  assert.equal(res.status, 201);
  const cookie = readSetCookie(res)!;
  return `${cookie.name}=${cookie.value}`;
}

const RAW_KEY = "sk-live-chatfire-test-key-1234567890";
/**
 * The bullet run `maskSecret` inserts between the head and tail. Asserted
 * literally rather than through a regex so a locale/encoding change in the
 * mask character cannot silently weaken the redaction check.
 */
const MASK_BULLETS = "•••••••";

let providerSeedCounter = 0;

/**
 * Seeds a chatfire provider. Pass `useUniqueName: false` to get the literal
 * name "ChatFire" (needed by the duplicate-name test); every other caller
 * gets a unique name, since the API rejects duplicate names.
 */
async function seedChatFireProvider(
  stores: Stores,
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  providerSeedCounter += 1;
  const name =
    overrides.name ??
    (overrides.useUniqueName === false ? "ChatFire" : `ChatFire #${providerSeedCounter}`);
  const { useUniqueName: _ignored, ...rest } = overrides;
  const res = await jsonRequest("/api/v1/admin/providers", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      name,
      providerType: "chatfire",
      baseUrl: "https://api.chatfire.site",
      apiKey: RAW_KEY,
      ...rest,
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: any };
  return { id: body.data.id as string, row: stores.aiProviders.get(body.data.id) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 1. Authorization
// ---------------------------------------------------------------------------

test("C6.3 Auth - anonymous requests are rejected", async () => {
  setupDb();
  try {
    const res = await jsonRequest("/api/v1/admin/providers", { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
  } finally {
    teardownDb();
  }
});

test("C6.3 Auth - non-admin cannot create/update/delete providers or models", async () => {
  const stores = setupDb();
  try {
    const cookie = await userSession();
    const targets = [
      ["/api/v1/admin/providers", "POST"],
      ["/api/v1/admin/providers/x", "PATCH"],
      ["/api/v1/admin/providers/x", "DELETE"],
      ["/api/v1/admin/models", "POST"],
      ["/api/v1/admin/models/x", "PATCH"],
      ["/api/v1/admin/models/x", "DELETE"],
      ["/api/v1/admin/provider-types", "GET"],
    ];
    for (const [path, method] of targets) {
      const res = await jsonRequest(path as string, { method: method as string, cookie, body: "{}" });
      assert.equal(res.status, 403, `${method} ${path} must be admin-only`);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "FORBIDDEN");
    }
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 2. Provider CRUD + adapter-type validation
// ---------------------------------------------------------------------------

test("C6.3 Provider CRUD - create, read, update, delete", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);

    // Create
    const created = await seedChatFireProvider(stores, cookie, { useUniqueName: false });
    assert.ok(created.id, "provider gets an id");

    // Read single
    const getRes = await jsonRequest(`/api/v1/admin/providers/${created.id}`, { cookie });
    assert.equal(getRes.status, 200);
    const got = (await getRes.json()) as { data: any };
    assert.equal(got.data.name, "ChatFire");
    assert.equal(got.data.providerType, "chatfire");
    assert.equal(got.data.baseUrl, "https://api.chatfire.site");

    // List
    const listRes = await jsonRequest("/api/v1/admin/providers", { cookie });
    assert.equal(listRes.status, 200);
    const listed = (await listRes.json()) as { data: any[] };
    assert.equal(listed.data.length, 1);

    // Update
    const patchRes = await jsonRequest(`/api/v1/admin/providers/${created.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ name: "ChatFire Video", baseUrl: "https://api.chatfire.site" }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as { data: any };
    assert.equal(patched.data.name, "ChatFire Video");

    // Delete (nothing references it yet)
    const delRes = await jsonRequest(`/api/v1/admin/providers/${created.id}`, {
      method: "DELETE",
      cookie,
    });
    assert.equal(delRes.status, 204);
    assert.equal(stores.aiProviders.size, 0);
  } finally {
    teardownDb();
  }
});

test("C6.3 Provider - unknown adapter type is rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const res = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "Mystery", providerType: "not-a-real-adapter" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /Unknown provider type/);
  } finally {
    teardownDb();
  }
});

test("C6.3 Provider - duplicate name is rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    await seedChatFireProvider(stores, cookie, { useUniqueName: false });
    const res = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "ChatFire", providerType: "chatfire" }),
    });
    assert.equal(res.status, 409);
  } finally {
    teardownDb();
  }
});

test("C6.3 Provider - validation rejects bad input", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);

    const res = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "", providerType: "chatfire" }),
    });
    assert.equal(res.status, 400);

    const badUrl = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "Bad URL", providerType: "chatfire", baseUrl: "not-a-url" }),
    });
    assert.equal(badUrl.status, 400);
    const badUrlBody = (await badUrl.json()) as { error: { message: string } };
    assert.match(badUrlBody.error.message, /baseUrl must be a valid URL/);

    const emptyPatch = await jsonRequest("/api/v1/admin/providers/x", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({}),
    });
    assert.equal(emptyPatch.status, 400);
  } finally {
    teardownDb();
  }
});

test("C6.3 Provider - update without apiKey keeps the stored key", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const { id, row } = await seedChatFireProvider(stores, cookie);
    const sealedBefore = row.apiKeySecret;

    const res = await jsonRequest(`/api/v1/admin/providers/${id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(res.status, 200);
    assert.equal(stores.aiProviders.get(id)!.apiKeySecret, sealedBefore, "key must be untouched");
  } finally {
    teardownDb();
  }
});

test("C6.3 Provider - apiKey rotation replaces the sealed envelope", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const { id, row } = await seedChatFireProvider(stores, cookie);
    const sealedBefore = row.apiKeySecret as string;

    const res = await jsonRequest(`/api/v1/admin/providers/${id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ apiKey: "sk-rotated-key-9999" }),
    });
    assert.equal(res.status, 200);
    const after = stores.aiProviders.get(id)!.apiKeySecret as string;
    assert.notEqual(after, sealedBefore, "envelope must change");
    assert.equal(providerSecretStore.reveal(after), "sk-rotated-key-9999");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 3. API-key redaction (the core secrecy guarantee)
// ---------------------------------------------------------------------------

test("C6.3 Secrets - the raw key and the sealed envelope NEVER appear in responses", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const { id } = await seedChatFireProvider(stores, cookie);

    const paths = [
      `/api/v1/admin/providers`,
      `/api/v1/admin/providers/${id}`,
      `/api/v1/ai-providers`,
      `/api/v1/ai-providers/${id}`,
    ];
    for (const path of paths) {
      const res = await jsonRequest(path, { cookie });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(RAW_KEY), `raw API key must not appear in ${path}`);
      assert.ok(
        !text.includes("api_key_secret"),
        `sealed envelope column name must not appear in ${path}`,
      );
      // Also assert nothing that looks like the envelope format leaks.
      assert.ok(!text.includes("icooro-v1:"), `envelope prefix must not appear in ${path}`);
    }

    // The masked preview must be the only key-shaped value exposed.
    const res = await jsonRequest(`/api/v1/admin/providers/${id}`, { cookie });
    const body = (await res.json()) as { data: any };
    assert.equal(body.data.hasApiKey, true);
    // Masked preview: first two chars, a fixed bullet run, last four chars.
    assert.equal(body.data.apiKeyMasked, `sk${MASK_BULLETS}7890`);
    assert.ok(
      body.data.apiKeyMasked.length < RAW_KEY.length,
      "the masked preview must be strictly shorter than the raw key",
    );
    assert.ok(!body.data.apiKeyMasked.includes("1234567890"));
    assert.equal(body.data.apiKey, undefined, "no apiKey field is ever serialized");
  } finally {
    teardownDb();
  }
});

test("C6.3 Secrets - a provider without a key reports hasApiKey false", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const res = await jsonRequest("/api/v1/admin/providers", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "Keyless", providerType: "chatfire" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { data: any };
    assert.equal(body.data.hasApiKey, false);
    assert.equal(body.data.apiKeyMasked, null);
  } finally {
    teardownDb();
  }
});

test("C6.3 Secrets - envelope round-trip, tamper detection, and masking", () => {
  const sealed = providerSecretStore.seal("sk-abc1234567890");
  assert.equal(providerSecretStore.reveal(sealed), "sk-abc1234567890");

  // Sealing is non-deterministic (random IV) but always reversible.
  assert.notEqual(providerSecretStore.seal("sk-abc1234567890"), sealed);

  // Tampering is detected.
  const parts = sealed.split(":");
  const tampered = [parts[0], parts[1], parts[2], "bm90dmFsaWQ="].join(":");
  assert.throws(() => providerSecretStore.reveal(tampered));

  // Masking never reveals the full key.
  const masked = maskSecret(sealed)!;
  assert.ok(masked.length < "sk-abc1234567890".length);
  assert.ok(!masked.includes("1234567890"));

  assert.equal(hasSecret(sealed), true);
  assert.equal(hasSecret(null), false);
  assert.equal(maskSecret(null), null);
});

// ---------------------------------------------------------------------------
// 4. Model CRUD + provider relationship
// ---------------------------------------------------------------------------

async function seedModel(
  cookie: string,
  providerId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await jsonRequest("/api/v1/admin/models", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      providerId,
      name: "Seedance 2.5",
      modelId: "doubao-seedance-2-5-260628",
      capability: "video",
      jobTypes: ["text-to-video"],
      ...overrides,
    }),
  });
  return { status: res.status, body: (await res.json()) as { data: any } };
}

test("C6.3 Model CRUD - create, read, update, delete", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);

    // Create
    const created = await seedModel(cookie, provider.id);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.modelId, "doubao-seedance-2-5-260628");
    assert.deepEqual(created.body.data.jobTypes, ["text-to-video"]);
    assert.equal(created.body.data.providerName, "ChatFire #6");

    // Read
    const getRes = await jsonRequest(`/api/v1/admin/models/${created.body.data.id}`, { cookie });
    assert.equal(getRes.status, 200);

    // Update
    const patchRes = await jsonRequest(`/api/v1/admin/models/${created.body.data.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ name: "Seedance 2.5 Pro", jobTypes: ["text-to-video"] }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as { data: any };
    assert.equal(patched.data.name, "Seedance 2.5 Pro");

    // Delete (unreferenced)
    const delRes = await jsonRequest(`/api/v1/admin/models/${created.body.data.id}`, {
      method: "DELETE",
      cookie,
    });
    assert.equal(delRes.status, 204);
  } finally {
    teardownDb();
  }
});

test("C6.3 Model - binding to a nonexistent provider is rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const res = await jsonRequest("/api/v1/admin/models", {
      method: "POST",
      cookie,
      body: JSON.stringify({
        providerId: randomUUID(),
        name: "Orphan Model",
        modelId: "orphan-1",
        capability: "video",
      }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.match(body.error.message, /Provider not found/);
  } finally {
    teardownDb();
  }
});

test("C6.3 Model - duplicate (provider, modelId) is rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    const first = await seedModel(cookie, provider.id);
    assert.equal(first.status, 201);
    const second = await seedModel(cookie, provider.id);
    assert.equal(second.status, 409);
  } finally {
    teardownDb();
  }
});

test("C6.3 Model - invalid capability and job types are rejected", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);

    const badCapability = await seedModel(cookie, provider.id, { capability: "hologram" });
    assert.equal(badCapability.status, 400);

    const badJobType = await seedModel(cookie, provider.id, {
      modelId: "model-bad-job",
      jobTypes: ["text-to-hologram"],
    });
    assert.equal(badJobType.status, 400);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 5. Enable/disable semantics
// ---------------------------------------------------------------------------

test("C6.3 Enable/Disable - provider and model can be toggled", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    const model = await seedModel(cookie, provider.id);

    const offProvider = await jsonRequest(`/api/v1/admin/providers/${provider.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(offProvider.status, 200);
    assert.equal(((await offProvider.json()) as { data: any }).data.enabled, false);

    const offModel = await jsonRequest(`/api/v1/admin/models/${model.body.data.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(offModel.status, 200);
    assert.equal(((await offModel.json()) as { data: any }).data.enabled, false);
  } finally {
    teardownDb();
  }
});

test("C6.3 Enable/Disable - generation selection lists only enabled records", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    const model = await seedModel(cookie, provider.id);

    // Everything enabled → both lists populated
    let provRes = await jsonRequest("/api/v1/ai-providers", { cookie });
    assert.equal(((await provRes.json()) as { data: any[] }).data.length, 1);
    let modelRes = await jsonRequest("/api/v1/ai-models", { cookie });
    assert.equal(((await modelRes.json()) as { data: any[] }).data.length, 1);

    // Disable the provider → model disappears with it
    await jsonRequest(`/api/v1/admin/providers/${provider.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: false }),
    });
    provRes = await jsonRequest("/api/v1/ai-providers", { cookie });
    assert.equal(((await provRes.json()) as { data: any[] }).data.length, 0);
    modelRes = await jsonRequest("/api/v1/ai-models", { cookie });
    assert.equal(((await modelRes.json()) as { data: any[] }).data.length, 0, "model of disabled provider must be hidden");

    // Re-enable provider but disable the model
    await jsonRequest(`/api/v1/admin/providers/${provider.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: true }),
    });
    await jsonRequest(`/api/v1/admin/models/${model.body.data.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: false }),
    });
    provRes = await jsonRequest("/api/v1/ai-providers", { cookie });
    assert.equal(((await provRes.json()) as { data: any[] }).data.length, 1);
    modelRes = await jsonRequest("/api/v1/ai-models", { cookie });
    assert.equal(((await modelRes.json()) as { data: any[] }).data.length, 0, "disabled model must be hidden");

    // Capability filter works
    await jsonRequest(`/api/v1/admin/models/${model.body.data.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: true }),
    });
    modelRes = await jsonRequest("/api/v1/ai-models?capability=video", { cookie });
    assert.equal(((await modelRes.json()) as { data: any[] }).data.length, 1);
    modelRes = await jsonRequest("/api/v1/ai-models?capability=image", { cookie });
    assert.equal(((await modelRes.json()) as { data: any[] }).data.length, 0);
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 6. Safe-delete guards
// ---------------------------------------------------------------------------

test("C6.3 Delete safety - provider with models cannot be deleted", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    await seedModel(cookie, provider.id);

    const res = await jsonRequest(`/api/v1/admin/providers/${provider.id}`, {
      method: "DELETE",
      cookie,
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "CONFLICT");
    assert.match(body.error.message, /model\(s\) are still bound/);
    assert.ok(stores.aiProviders.has(provider.id), "provider row must still exist");
  } finally {
    teardownDb();
  }
});

test("C6.3 Delete safety - model referenced by a job cannot be deleted", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    const model = await seedModel(cookie, provider.id);
    stores.aiJobs.set("job-1", { id: "job-1", modelId: model.body.data.id, status: "queued" });

    const res = await jsonRequest(`/api/v1/admin/models/${model.body.data.id}`, {
      method: "DELETE",
      cookie,
    });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { error: { message: string } }).error.message,
      /generation job\(s\) still reference/,
    );
    assert.ok(stores.aiModels.has(model.body.data.id), "model row must still exist");
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 7. Generation selection resolves to configured provider/model
// ---------------------------------------------------------------------------

async function seedProject(stores: Stores, cookie: string): Promise<string> {
  const res = await jsonRequest("/api/v1/projects", {
    method: "POST",
    cookie,
    body: JSON.stringify({ name: "Provider Test Project" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { data: any }).data.id;
}

test("C6.3 Generation - job creation resolves to the configured provider and model", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    const model = await seedModel(cookie, provider.id);
    const projectId = await seedProject(stores, cookie);

    const res = await jsonRequest(`/api/v1/projects/${projectId}/jobs`, {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prompt: "a neon city skyline at dusk",
        targetMediaType: "video",
        jobType: "text-to-video",
        providerId: provider.id,
        modelId: model.body.data.id,
      }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { data: any };
    assert.equal(created.data.providerId, provider.id);
    assert.equal(created.data.modelId, model.body.data.id);
    assert.equal(created.data.status, "queued");
  } finally {
    teardownDb();
  }
});

test("C6.3 Generation - disabled provider or model cannot be bound to a new job", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    const model = await seedModel(cookie, provider.id);
    const projectId = await seedProject(stores, cookie);

    await jsonRequest(`/api/v1/admin/providers/${provider.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: false }),
    });
    let res = await jsonRequest(`/api/v1/projects/${projectId}/jobs`, {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prompt: "x",
        targetMediaType: "video",
        jobType: "text-to-video",
        providerId: provider.id,
        modelId: model.body.data.id,
      }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { message: string } }).error.message, "AI Provider is disabled");

    // Re-enable provider, disable model
    await jsonRequest(`/api/v1/admin/providers/${provider.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: true }),
    });
    await jsonRequest(`/api/v1/admin/models/${model.body.data.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ enabled: false }),
    });
    res = await jsonRequest(`/api/v1/projects/${projectId}/jobs`, {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prompt: "x",
        targetMediaType: "video",
        jobType: "text-to-video",
        providerId: provider.id,
        modelId: model.body.data.id,
      }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { message: string } }).error.message, "AI Model is disabled");
  } finally {
    teardownDb();
  }
});

test("C6.3 Generation - model must belong to the provider and match the media type", async () => {
  const stores = setupDb();
  try {
    const cookie = await adminSession(stores);
    const provider = await seedChatFireProvider(stores, cookie);
    const model = await seedModel(cookie, provider.id);
    const projectId = await seedProject(stores, cookie);

    // Wrong media type for the model capability
    const wrongType = await jsonRequest(`/api/v1/projects/${projectId}/jobs`, {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prompt: "x",
        targetMediaType: "image",
        jobType: "text-to-image",
        providerId: provider.id,
        modelId: model.body.data.id,
      }),
    });
    assert.equal(wrongType.status, 400);
    assert.equal(
      ((await wrongType.json()) as { error: { message: string } }).error.message,
      "Model does not support the requested media type",
    );

    // A second provider with its own model — that model is not bound to the
    // first provider, so pairing them must be rejected.
    const otherProvider = await seedChatFireProvider(stores, cookie);
    const orphan = await jsonRequest("/api/v1/admin/models", {
      method: "POST",
      cookie,
      body: JSON.stringify({
        providerId: otherProvider.id,
        name: "Other Model",
        modelId: "other-model-1",
        capability: "video",
      }),
    });
    assert.equal(orphan.status, 201);
    const otherModelId = ((await orphan.json()) as { data: any }).data.id;

    const mismatch = await jsonRequest(`/api/v1/projects/${projectId}/jobs`, {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prompt: "x",
        targetMediaType: "video",
        jobType: "text-to-video",
        providerId: provider.id,
        modelId: otherModelId,
      }),
    });
    assert.equal(mismatch.status, 400);
    assert.equal(
      ((await mismatch.json()) as { error: { message: string } }).error.message,
      "Model does not belong to the specified provider",
    );
  } finally {
    teardownDb();
  }
});

// ---------------------------------------------------------------------------
// 8. Adapter factory + ChatFire resolution through the configured provider
// ---------------------------------------------------------------------------

test("C6.3 Adapter factory - chatfire is registered as a configurable video adapter type", () => {
  const types = listAdapterTypes();
  const chatfire = types.find((t) => t.providerType === "chatfire");
  assert.ok(chatfire, "chatfire must be a registered adapter type");
  assert.deepEqual(chatfire!.capabilities, ["video"]);

  assert.ok(isKnownAdapterType("chatfire"));
  assert.ok(isKnownAdapterType("ChatFire"), "type matching is case-insensitive");
  assert.equal(isKnownAdapterType("nope"), false);

  assert.ok(getAdapterFactory("chatfire"), "factory must be retrievable");
  assert.equal(getAdapterFactory("nope"), undefined);
});

test("C6.3 Adapter factory - resolveAdapter honours capability and unknown types", () => {
  const record = {
    providerType: "chatfire",
    baseUrl: "https://api.chatfire.site",
    apiKeySecret: providerSecretStore.seal("sk-resolve-test-123456"),
  };

  assert.ok(resolveAdapter(record, "video"), "video capability must resolve");
  assert.equal(resolveAdapter(record, "image"), undefined, "chatfire has no image capability");
  assert.equal(
    resolveAdapter({ providerType: "unknown", baseUrl: null, apiKeySecret: null }, "video"),
    undefined,
    "unknown type must not resolve",
  );
});

test("C6.7.2.3 Factory - constructor failures: config errors degrade, bugs propagate", () => {
  // Scratch types registered only for this assertion set; they use unique
  // names so no real provider type is affected.
  registerAdapterFactory(
    "factory_test_config_boom",
    "Factory Test Config Boom",
    ["text"],
    () => {
      // Configuration-invalid record: the adapter's own contract rejected it.
      throw new ProviderError("bad provider configuration", {
        provider: "factory_test_config_boom",
      });
    },
  );
  registerAdapterFactory(
    "factory_test_bug_boom",
    "Factory Test Bug Boom",
    ["text"],
    () => {
      // Programmer bug / invariant violation: NOT a ProviderError.
      throw new TypeError("programmer bug in adapter constructor");
    },
  );

  const configRow = {
    providerType: "factory_test_config_boom",
    baseUrl: null,
    apiKeySecret: null,
  };
  const bugRow = {
    providerType: "factory_test_bug_boom",
    baseUrl: null,
    apiKeySecret: null,
  };

  // Config errors degrade to the documented "no usable adapter" outcome.
  assert.equal(
    resolveAdapter(configRow, "text"),
    undefined,
    "a ProviderError from construction must yield undefined, not throw",
  );

  // Anything else stays loud so bugs surface at their true location.
  assert.throws(
    () => resolveAdapter(bugRow, "text"),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /programmer bug in adapter constructor/);
      return true;
    },
    "non-ProviderError constructor failures must propagate",
  );
});

test("C6.3 ChatFire - a configured provider record resolves to a working ChatFire adapter", async () => {
  const stores = setupDb();
  // Isolate this test from any ambient CHATFIRE_API_KEY in the environment:
  // the resolved adapter must use the record's sealed key, never env.
  const originalKey = process.env.CHATFIRE_API_KEY;
  delete process.env.CHATFIRE_API_KEY;
  try {
    const cookie = await adminSession(stores);
    const { row } = await seedChatFireProvider(stores, cookie);

    // Stub globalThis.fetch BEFORE resolving the adapter: ChatFireVideoProvider
    // captures `globalThis.fetch` at construction time, so the record-built
    // instance must be constructed after the stub is in place. This keeps the
    // test fully offline — no real network call is ever made.
    let capturedUrl = "";
    let capturedAuth = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(JSON.stringify({ id: "task-configured-1", status: "QUEUED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      // Resolve from the database row with the fetch stub active.
      const adapter = resolveVideoProvider(row);
      assert.ok(adapter, "provider record must resolve to an adapter");
      assert.equal((adapter as ChatFireVideoProvider).providerType, "chatfire");

      const result = await adapter!.createJob({
        prompt: "a cinematic wide shot of a neon city at dusk",
        modelId: "doubao-seedance-2-5-260628",
      });
      assert.equal(result.externalJobId, "task-configured-1");
      assert.equal(capturedUrl, "https://api.chatfire.site/volcengine/api/v3/contents/generations/tasks");
      assert.equal(capturedAuth, `Bearer ${RAW_KEY}`, "the record's API key must be used, not env");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (originalKey !== undefined) {
      process.env.CHATFIRE_API_KEY = originalKey;
    }
    teardownDb();
  }
});
