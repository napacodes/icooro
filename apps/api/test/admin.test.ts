/**
 * C6.2 — Admin Control Plane API Tests.
 *
 * Exercises the admin control plane endpoints:
 *   - Authentication and admin authorization enforcement
 *   - Admin Overview: aggregation of users, projects, providers, models, jobs
 *   - Users: list, get, update role (demote/promote) without exposing password hashes
 *   - Projects: list and get projects across all users with owner attribution
 *   - AI Providers: list, get, update without exposing credentials
 *   - AI Models: list, get, update
 *   - Generation Jobs: list, filter, inspect, and cancel active jobs
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { setDb } from "../src/db/index.js";
import { app } from "../src/index.js";

// ---------------------------------------------------------------------------
// In-memory fake DB supporting all admin tables
// ---------------------------------------------------------------------------

interface AdminStores {
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

function walkPredicate(cond: unknown): Array<{ column: string; op: "eq" | "gt"; value: unknown }> {
  const out: Array<{ column: string; op: "eq" | "gt"; value: unknown }> = [];
  if (!cond || typeof cond !== "object") return out;
  const c = cond as any;
  const chunks: unknown[] = Array.isArray(c.queryChunks) ? c.queryChunks : [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || typeof chunk !== "object") continue;
    const ck = chunk as any;
    if (ck.queryChunks) {
      out.push(...walkPredicate(chunk));
      continue;
    }
    const columnName =
      typeof ck.name === "string"
        ? ck.name
        : ck.name && typeof ck.name === "object" && typeof ck.name.name === "string"
          ? ck.name.name
          : null;
    if (columnName) {
      const next = chunks[i + 1] as any;
      const after = chunks[i + 2] as any;
      if (next && typeof next === "object" && Array.isArray(next.value)) {
        const marker = (next.value as string[]).join("");
        if (marker === " = " || marker === " > " || marker === " < " || marker === " >= " || marker === " <= ") {
          const afterValue =
            after && typeof after === "object" && "value" in after
              ? after.value
              : after;
          out.push({
            column: columnName,
            op: marker === " = " ? "eq" : marker === " > " ? "gt" : "eq",
            value: afterValue,
          });
          i += 2;
        }
      }
    }
  }
  return out;
}

function rowMatches(
  row: Record<string, unknown>,
  terms: Array<{ column: string; op: "eq" | "gt"; value: unknown }>,
): boolean {
  for (const t of terms) {
    const camel = t.column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const actual = t.column in row ? row[t.column] : row[camel];
    if (t.op === "eq") {
      if (actual !== t.value) return false;
    } else if (t.op === "gt") {
      if (!(actual instanceof Date) || !(t.value instanceof Date)) return false;
      if (!(actual.getTime() > t.value.getTime())) return false;
    }
  }
  return true;
}

function makeAdminFakeDb(stores: AdminStores) {
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
    select() {
      function runWhere(table: unknown, cond: unknown) {
        const terms = walkPredicate(cond);
        const store = storeFor(table);
        return Array.from(store.values())
          .filter((r) => rowMatches(r, terms))
          .map((r) => ({ ...r }));
      }
      return {
        from(table: unknown) {
          return {
            where(cond: unknown) {
              const rows = runWhere(table, cond);
              return {
                orderBy(_clause: unknown) {
                  return Promise.resolve(rows);
                },
                then(resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) {
                  return Promise.resolve(rows).then(resolve, reject);
                },
              };
            },
            orderBy(_clause: unknown) {
              const store = storeFor(table);
              const allRows = Array.from(store.values()).map((r) => ({ ...r }));
              return {
                where(cond: unknown) {
                  return Promise.resolve(runWhere(table, cond));
                },
                then(resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) {
                  return Promise.resolve(allRows).then(resolve, reject);
                },
              };
            },
            then(resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) {
              const store = storeFor(table);
              const allRows = Array.from(store.values()).map((r) => ({ ...r }));
              return Promise.resolve(allRows).then(resolve, reject);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown>) {
          const tableName = tableNameOf(table);
          const newId = (vals.id as string) ?? randomUUID();
          const store = storeFor(table);
          const now = new Date();
          const defaulted: Record<string, unknown> = { id: newId, ...vals };
          if (defaulted.createdAt === undefined) defaulted.createdAt = now;
          if (defaulted.updatedAt === undefined) defaulted.updatedAt = now;
          store.set(newId, defaulted);
          return {
            $returningId() {
              return Promise.resolve([{ id: newId }]);
            },
          };
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
                  affected++;
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
          for (const [k, row] of Array.from(store.entries())) {
            if (rowMatches(row, terms)) {
              store.delete(k);
              affected++;
            }
          }
          return Promise.resolve([{ affectedRows: affected }]);
        },
      };
    },
  };

  const fakeDb: any = {
    select: ops.select,
    insert: ops.insert,
    update: ops.update,
    delete: ops.delete,
    async transaction<T>(cb: (tx: any) => Promise<T>): Promise<T> {
      return await cb(fakeDb);
    },
    __stores: stores,
  };
  return fakeDb;
}

function setupAdminDb() {
  const stores: AdminStores = {
    users: new Map(),
    sessions: new Map(),
    projects: new Map(),
    aiProviders: new Map(),
    aiModels: new Map(),
    aiJobs: new Map(),
  };
  setDb(makeAdminFakeDb(stores));
  return stores;
}

function teardownAdminDb() {
  setDb(null as any);
}

async function jsonRequest(
  appInstance: typeof app,
  path: string,
  init: RequestInit & { cookie?: string } = {},
) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init.cookie) headers.set("cookie", init.cookie);
  const req = new Request(`http://localhost${path}`, {
    ...init,
    headers,
  });
  return appInstance.fetch(req);
}

function readSetCookie(res: Response): { name: string; value: string } | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const first = raw.split(";")[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq === -1) return null;
  return { name: first.slice(0, eq), value: first.slice(eq + 1) };
}

async function createAdminSession(stores: AdminStores, email = "admin@example.com", name = "Admin User") {
  const res = await jsonRequest(app, "/api/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "longenoughpassword", name }),
  });
  assert.equal(res.status, 201);
  const cookie = readSetCookie(res)!;
  // Promote to admin directly in user store
  for (const u of stores.users.values()) {
    if (u.email === email) {
      u.role = "admin";
    }
  }
  return `${cookie.name}=${cookie.value}`;
}

async function createUserSession(email = "user@example.com", name = "Normal User") {
  const res = await jsonRequest(app, "/api/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "longenoughpassword", name }),
  });
  assert.equal(res.status, 201);
  const cookie = readSetCookie(res)!;
  return `${cookie.name}=${cookie.value}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("C6.2 Admin - non-admin is forbidden from admin endpoints", async () => {
  setupAdminDb();
  try {
    const userCookie = await createUserSession();
    const res = await jsonRequest(app, "/api/v1/admin/overview", { cookie: userCookie });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "FORBIDDEN");
  } finally {
    teardownAdminDb();
  }
});

test("C6.2 Admin Overview - returns aggregated counts and job status breakdown", async () => {
  const stores = setupAdminDb();
  try {
    const adminCookie = await createAdminSession(stores);

    // Seed dummy records
    stores.projects.set("p1", { id: "p1", name: "Project 1", ownerId: "u1", status: "draft" });
    stores.aiProviders.set("prov1", { id: "prov1", name: "ChatFire", providerType: "chatfire", enabled: true });
    stores.aiModels.set("m1", { id: "m1", providerId: "prov1", name: "Seedance", modelId: "seedance", capability: "video", enabled: true });
    stores.aiJobs.set("j1", { id: "j1", status: "queued", jobType: "video" });
    stores.aiJobs.set("j2", { id: "j2", status: "completed", jobType: "video" });

    const res = await jsonRequest(app, "/api/v1/admin/overview", { cookie: adminCookie });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: any };
    assert.equal(body.data.usersCount, 1);
    assert.equal(body.data.adminUsersCount, 1);
    assert.equal(body.data.projectsCount, 1);
    assert.equal(body.data.providersCount, 1);
    assert.equal(body.data.enabledProvidersCount, 1);
    assert.equal(body.data.modelsCount, 1);
    assert.equal(body.data.enabledModelsCount, 1);
    assert.equal(body.data.jobsCount, 2);
    assert.equal(body.data.jobsByStatus.queued, 1);
    assert.equal(body.data.jobsByStatus.completed, 1);
    assert.equal(body.data.jobsByStatus.failed, 0);
  } finally {
    teardownAdminDb();
  }
});

test("C6.2 Admin Users - lists users and NEVER exposes passwordHash", async () => {
  const stores = setupAdminDb();
  try {
    const adminCookie = await createAdminSession(stores);
    await createUserSession("regular@example.com", "Regular User");

    const res = await jsonRequest(app, "/api/v1/admin/users", { cookie: adminCookie });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    assert.equal(body.data.length, 2);

    for (const u of body.data) {
      assert.equal(typeof u.id, "string");
      assert.equal(typeof u.email, "string");
      assert.equal(typeof u.name, "string");
      assert.equal(typeof u.role, "string");
      assert.equal(u.passwordHash, undefined, "passwordHash MUST NEVER be exposed");
    }
  } finally {
    teardownAdminDb();
  }
});

test("C6.2 Admin Users - can update user role (promote/demote)", async () => {
  const stores = setupAdminDb();
  try {
    const adminCookie = await createAdminSession(stores);
    await createUserSession("target@example.com", "Target User");

    const targetUser = Array.from(stores.users.values()).find((u) => u.email === "target@example.com")!;
    assert.equal(targetUser.role, "user");

    const patchRes = await jsonRequest(app, `/api/v1/admin/users/${targetUser.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(patchRes.status, 200);
    const body = (await patchRes.json()) as { data: any };
    assert.equal(body.data.role, "admin");
    assert.equal(body.data.passwordHash, undefined);

    // Verify in store
    assert.equal(stores.users.get(targetUser.id as string)!.role, "admin");
  } finally {
    teardownAdminDb();
  }
});

test("C6.2 Admin Projects - lists all projects with owner metadata", async () => {
  const stores = setupAdminDb();
  try {
    const adminCookie = await createAdminSession(stores);
    const normalCookie = await createUserSession("owner@example.com", "Owner Name");

    // Normal user creates project
    const createProj = await jsonRequest(app, "/api/v1/projects", {
      method: "POST",
      cookie: normalCookie,
      body: JSON.stringify({ name: "User's Masterpiece" }),
    });
    assert.equal(createProj.status, 201);
    const created = (await createProj.json()) as { data: any };

    // Admin lists projects via admin endpoint
    const res = await jsonRequest(app, "/api/v1/admin/projects", { cookie: adminCookie });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: any[] };
    const found = body.data.find((p) => p.id === created.data.id);
    assert.ok(found, "Created project is found in admin projects list");
    assert.equal(found.ownerEmail, "owner@example.com");
    assert.equal(found.ownerName, "Owner Name");
  } finally {
    teardownAdminDb();
  }
});

test("C6.2 Admin AI Providers - lists and toggles providers without leaking secrets", async () => {
  const stores = setupAdminDb();
  try {
    const adminCookie = await createAdminSession(stores);

    stores.aiProviders.set("cf1", {
      id: "cf1",
      name: "ChatFire Video",
      providerType: "chatfire",
      enabled: true,
      config: {
        apiKey: "SUPER_SECRET_KEY",
        secretKey: "TOP_SECRET",
        baseUrl: "https://api.chatfire.site",
      },
    });

    const res = await jsonRequest(app, "/api/v1/admin/providers", { cookie: adminCookie });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: any[] };
    assert.equal(body.data.length, 1);
    const prov = body.data[0];
    assert.equal(prov.name, "ChatFire Video");
    assert.equal(prov.config?.apiKey, undefined, "apiKey must be stripped");
    assert.equal(prov.config?.secretKey, undefined, "secretKey must be stripped");
    assert.equal(prov.config?.baseUrl, "https://api.chatfire.site");

    // Toggle provider to disabled
    const patchRes = await jsonRequest(app, "/api/v1/admin/providers/cf1", {
      method: "PATCH",
      cookie: adminCookie,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as { data: any };
    assert.equal(patched.data.enabled, false);
    assert.equal(patched.data.config?.apiKey, undefined);
  } finally {
    teardownAdminDb();
  }
});

test("C6.2 Admin AI Models - lists and toggles models", async () => {
  const stores = setupAdminDb();
  try {
    const adminCookie = await createAdminSession(stores);

    stores.aiProviders.set("cf1", { id: "cf1", name: "ChatFire", providerType: "chatfire", enabled: true });
    stores.aiModels.set("m1", {
      id: "m1",
      providerId: "cf1",
      name: "Seedance 2.0",
      modelId: "seedance-2.0",
      capability: "video",
      enabled: true,
    });

    const res = await jsonRequest(app, "/api/v1/admin/models", { cookie: adminCookie });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: any[] };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].providerName, "ChatFire");

    // Toggle model to disabled
    const patchRes = await jsonRequest(app, "/api/v1/admin/models/m1", {
      method: "PATCH",
      cookie: adminCookie,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as { data: any };
    assert.equal(patched.data.enabled, false);
  } finally {
    teardownAdminDb();
  }
});

test("C6.2 Admin Generation Jobs - lists jobs and cancels active job", async () => {
  const stores = setupAdminDb();
  try {
    const adminCookie = await createAdminSession(stores);

    stores.aiJobs.set("job-1", {
      id: "job-1",
      jobType: "video",
      status: "queued",
      progress: 0,
      projectId: null,
      providerId: null,
    });

    // List jobs
    const listRes = await jsonRequest(app, "/api/v1/admin/jobs", { cookie: adminCookie });
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { data: any[] };
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].id, "job-1");

    // Cancel job
    const cancelRes = await jsonRequest(app, "/api/v1/admin/jobs/job-1/cancel", {
      method: "POST",
      cookie: adminCookie,
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = (await cancelRes.json()) as { data: any };
    assert.equal(cancelBody.data.status, "cancelled");

    // Verify in store
    assert.equal(stores.aiJobs.get("job-1")!.status, "cancelled");
  } finally {
    teardownAdminDb();
  }
});
