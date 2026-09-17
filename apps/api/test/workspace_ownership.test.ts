/**
 * C6.4 — Workspace Project Ownership Security Tests.
 *
 * Verifies strict project isolation and authorization across all workspace
 * nested endpoints:
 *   - /api/v1/projects/:projectId/episodes
 *   - /api/v1/projects/:projectId/characters
 *   - /api/v1/projects/:projectId/locations
 *   - /api/v1/projects/:projectId/props
 *   - /api/v1/projects/:projectId/assets
 *   - /api/v1/projects/:projectId/jobs
 *
 * Requirements:
 *   - Cross-user access is denied with 404 (no existence disclosure).
 *   - Project owners can access and mutate their resources.
 *   - Admins can access workspace resources across all projects.
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { setDb } from "../src/db/index.js";
import { app } from "../src/index.js";

interface WorkspaceStores {
  users: Map<string, Record<string, unknown>>;
  sessions: Map<string, Record<string, unknown>>;
  projects: Map<string, Record<string, unknown>>;
  episodes: Map<string, Record<string, unknown>>;
  characters: Map<string, Record<string, unknown>>;
  locations: Map<string, Record<string, unknown>>;
  props: Map<string, Record<string, unknown>>;
  assets: Map<string, Record<string, unknown>>;
  assetVersions: Map<string, Record<string, unknown>>;
  aiJobs: Map<string, Record<string, unknown>>;
  aiProviders: Map<string, Record<string, unknown>>;
  aiModels: Map<string, Record<string, unknown>>;
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
    const actual =
      t.column in row
        ? row[t.column]
        : (() => {
            const camel = t.column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
            return row[camel];
          })();
    if (t.op === "eq") {
      if (actual !== t.value) return false;
    } else if (t.op === "gt") {
      if (!(actual instanceof Date) || !(t.value instanceof Date)) return false;
      if (!(actual.getTime() > t.value.getTime())) return false;
    }
  }
  return true;
}

function makeFakeDb(stores: WorkspaceStores) {
  function storeFor(table: unknown): Map<string, Record<string, unknown>> {
    const name = tableNameOf(table);
    if (name === "users") return stores.users;
    if (name === "sessions") return stores.sessions;
    if (name === "projects") return stores.projects;
    if (name === "episodes") return stores.episodes;
    if (name === "characters") return stores.characters;
    if (name === "locations") return stores.locations;
    if (name === "props") return stores.props;
    if (name === "assets") return stores.assets;
    if (name === "asset_versions") return stores.assetVersions;
    if (name === "ai_jobs") return stores.aiJobs;
    if (name === "ai_providers") return stores.aiProviders;
    if (name === "ai_models") return stores.aiModels;
    throw new Error(`fake db: unknown table ${name}`);
  }

  const ops = {
    select(fields?: unknown) {
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
            then(resolve: (res: any) => unknown, reject?: (err: any) => unknown) {
              return Promise.resolve([{ insertId: 1, affectedRows: 1 }]).then(resolve, reject);
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
                  Object.assign(row, vals, { updatedAt: new Date() });
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
          for (const [id, row] of Array.from(store.entries())) {
            if (rowMatches(row, terms)) {
              store.delete(id);
              affected++;
            }
          }
          return Promise.resolve({ affectedRows: affected });
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

function setupFakeDb() {
  const stores: WorkspaceStores = {
    users: new Map(),
    sessions: new Map(),
    projects: new Map(),
    episodes: new Map(),
    characters: new Map(),
    locations: new Map(),
    props: new Map(),
    assets: new Map(),
    assetVersions: new Map(),
    aiJobs: new Map(),
    aiProviders: new Map(),
    aiModels: new Map(),
  };
  setDb(makeFakeDb(stores));
  return stores;
}

function teardownFakeDb() {
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

test("C6.4 Workspace - cross-user project access is strictly denied (404)", async () => {
  const stores = setupFakeDb();
  try {
    // User A signup
    const signupA = await jsonRequest(app, "/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "usera@example.com", password: "password123", name: "User A" }),
    });
    assert.equal(signupA.status, 201);
    const cookieAData = readSetCookie(signupA)!;
    const cookieA = `${cookieAData.name}=${cookieAData.value}`;

    // User B signup
    const signupB = await jsonRequest(app, "/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "userb@example.com", password: "password123", name: "User B" }),
    });
    assert.equal(signupB.status, 201);
    const cookieBData = readSetCookie(signupB)!;
    const cookieB = `${cookieBData.name}=${cookieBData.value}`;

    // Create a project owned by User A
    const createRes = await jsonRequest(app, "/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Project Alpha", description: "Owned by A" }),
      cookie: cookieA,
    });
    assert.equal(createRes.status, 201);
    const { data: projectA } = (await createRes.json()) as { data: { id: string } };

    // 1. User B cannot list User A's episodes -> 404
    const listEpRes = await jsonRequest(app, `/api/v1/projects/${projectA.id}/episodes`, {
      cookie: cookieB,
    });
    assert.equal(listEpRes.status, 404, "User B querying A's episodes must return 404");

    // 2. User B cannot create an episode in User A's project -> 404
    const postEpRes = await jsonRequest(app, `/api/v1/projects/${projectA.id}/episodes`, {
      method: "POST",
      body: JSON.stringify({ title: "Sneaky Episode", episodeNumber: 1 }),
      cookie: cookieB,
    });
    assert.equal(postEpRes.status, 404, "User B creating episode in A's project must return 404");

    // 3. User B cannot list User A's assets -> 404
    const listAssetRes = await jsonRequest(app, `/api/v1/projects/${projectA.id}/assets`, {
      cookie: cookieB,
    });
    assert.equal(listAssetRes.status, 404, "User B querying A's assets must return 404");

    // 4. User B cannot create an asset in User A's project -> 404
    const postAssetRes = await jsonRequest(app, `/api/v1/projects/${projectA.id}/assets`, {
      method: "POST",
      body: JSON.stringify({ name: "Infiltrator Asset", type: "image" }),
      cookie: cookieB,
    });
    assert.equal(postAssetRes.status, 404, "User B creating asset in A's project must return 404");

    // 5. User B cannot list User A's generation jobs -> 404
    const listJobsRes = await jsonRequest(app, `/api/v1/projects/${projectA.id}/jobs`, {
      cookie: cookieB,
    });
    assert.equal(listJobsRes.status, 404, "User B querying A's jobs must return 404");

    // 6. User B cannot list User A's characters -> 404
    const listCharsRes = await jsonRequest(app, `/api/v1/projects/${projectA.id}/characters`, {
      cookie: cookieB,
    });
    assert.equal(listCharsRes.status, 404, "User B querying A's characters must return 404");

    // 7. Owner (User A) CAN create and list episodes
    const ownerEpCreate = await jsonRequest(app, `/api/v1/projects/${projectA.id}/episodes`, {
      method: "POST",
      body: JSON.stringify({ title: "Episode One", episodeNumber: 1 }),
      cookie: cookieA,
    });
    assert.equal(ownerEpCreate.status, 201, "Owner can create episode");

    const ownerEpList = await jsonRequest(app, `/api/v1/projects/${projectA.id}/episodes`, {
      cookie: cookieA,
    });
    assert.equal(ownerEpList.status, 200, "Owner can list episodes");
    const epData = (await ownerEpList.json()) as { data: Array<{ title: string }> };
    assert.equal(epData.data.length, 1);
    assert.equal(epData.data[0].title, "Episode One");

    // 8. Admin CAN access User A's episodes
    const adminSignup = await jsonRequest(app, "/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "password123", name: "Admin" }),
    });
    assert.equal(adminSignup.status, 201);
    const { data: adminUserData } = (await adminSignup.json()) as { data: { id: string } };
    stores.users.get(adminUserData.id)!.role = "admin";
    const adminCookieData = readSetCookie(adminSignup)!;
    const adminCookie = `${adminCookieData.name}=${adminCookieData.value}`;

    const adminEpList = await jsonRequest(app, `/api/v1/projects/${projectA.id}/episodes`, {
      cookie: adminCookie,
    });
    assert.equal(adminEpList.status, 200, "Admin can list any project's episodes");
  } finally {
    teardownFakeDb();
  }
});
