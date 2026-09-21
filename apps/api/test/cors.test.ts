/**
 * C6.5 — CORS origin configuration.
 *
 * The API echoes a per-request `Access-Control-Allow-Origin` from an
 * allowlist driven by `API_CORS_ORIGINS`, always with
 * `Access-Control-Allow-Credentials: true`. A wildcard is never used, so
 * credentialed browser requests stay valid and unlisted origins get no
 * cross-origin access.
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

import { parseCorsOrigins } from "../src/env.js";
import { app } from "../src/index.js";

const ALLOWED = "http://localhost:3000";
const UNLISTED = "http://unlisted.example.com";

function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

test("C6.5 CORS - preflight for a configured origin is accepted", async () => {
  const res = await request("/api/v1/auth/signup", {
    method: "OPTIONS",
    headers: {
      origin: ALLOWED,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.ok(res.status >= 200 && res.status < 300, "preflight is 2xx");
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("C6.5 CORS - preflight for an unconfigured origin is not echoed", async () => {
  const res = await request("/api/v1/auth/signup", {
    method: "OPTIONS",
    headers: {
      origin: UNLISTED,
      "access-control-request-method": "POST",
    },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("C6.5 CORS - credentialed request from a configured origin is allowed", async () => {
  const res = await request("/api/v1/auth/me", { headers: { origin: ALLOWED } });
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("C6.5 CORS - request from an unconfigured origin gets no allow-origin", async () => {
  const res = await request("/api/v1/auth/me", { headers: { origin: UNLISTED } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("C6.5 CORS - error responses stay readable by the browser", async () => {
  // A validation failure must still carry the CORS headers, otherwise the
  // browser hides the body and the form cannot show why it failed.
  const res = await request("/api/v1/auth/signup", {
    method: "POST",
    headers: { origin: ALLOWED, "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", password: "longenough", name: "Bad" }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "INVALID_REQUEST");
});

// ---------------------------------------------------------------------------
// Origin parsing — `API_CORS_ORIGINS` is comma-separated and trims whitespace.
// The local development origin stays allowed when the variable is unset.
// ---------------------------------------------------------------------------

test("C6.5 CORS - parseCorsOrigins falls back to the local dev origin when unset", () => {
  assert.deepEqual(parseCorsOrigins(undefined), ["http://localhost:3000"]);
  assert.deepEqual(parseCorsOrigins(""), ["http://localhost:3000"]);
  assert.deepEqual(parseCorsOrigins("   "), ["http://localhost:3000"]);
});

test("C6.5 CORS - parseCorsOrigins splits and trims a comma-separated list", () => {
  assert.deepEqual(
    parseCorsOrigins("http://localhost:3000, http://192.168.1.49:3000"),
    ["http://localhost:3000", "http://192.168.1.49:3000"],
  );
  assert.deepEqual(parseCorsOrigins(" http://localhost:3000 "), [
    "http://localhost:3000",
  ]);
});

test("C6.5 CORS - parseCorsOrigins ignores empty entries", () => {
  assert.deepEqual(parseCorsOrigins(",http://localhost:3000,"), [
    "http://localhost:3000",
  ]);
});
