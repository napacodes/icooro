/**
 * Regression test - compose DB wiring for the api service.
 *
 * Root cause this guards against: `docker-compose.yml` passed the host's
 * `DATABASE_URL` (`...@localhost:3306/icooro`) straight into the `api`
 * container. Inside a container, `localhost` is the api container itself,
 * so every query failed with `ECONNREFUSED` and signup (and every other DB
 * route) returned a bare `500 INTERNAL_ERROR`. MySQL was perfectly healthy
 * the whole time - the api process simply could not reach it.
 *
 * Invariant: the api container's `DATABASE_URL` host must be the compose
 * `mysql` service hostname, and the credentials/database must match the
 * ones the `mysql` service is provisioned with.
 *
 * This lives in the api package so `pnpm test` covers it; the config is
 * part of the api service's runtime contract (no DB reachability = no
 * auth), and the pre-existing test suite runs entirely against an
 * in-memory fake DB, so it never exercised the real connection wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMPOSE_PATH = fileURLToPath(
  new URL("../../../docker-compose.yml", import.meta.url),
);
const ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));

interface ComposeService {
  name: string;
  environment: Record<string, string>;
}

/**
 * Reads the repo `.env` (the file compose interpolates at up time) into a
 * plain map. Deterministic and independent of the ambient `process.env`,
 * which each `node --test` file gets fresh.
 */
function readDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq === -1) continue;
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Minimal, dependency-free reader for the subset of compose structure this
 * guard needs: top-level `services:` entries and their `environment:`
 * mappings. It does not aim to be a general YAML parser.
 */
function readComposeServices(path: string): ComposeService[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  let servicesStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^services:\s*$/.test(lines[i]!)) {
      servicesStart = i;
      break;
    }
  }
  if (servicesStart === -1) {
    throw new Error("docker-compose.yml has no top-level `services:` block");
  }

  const services: ComposeService[] = [];
  let current: ComposeService | null = null;
  let inEnvironment = false;

  for (let i = servicesStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;

    // A line starting at column 0 ends the `services:` block.
    if (/^\S/.test(line)) break;

    // Two-space indented `name:` => a service key.
    const serviceMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (serviceMatch) {
      current = { name: serviceMatch[1]!, environment: {} };
      services.push(current);
      inEnvironment = false;
      continue;
    }

    if (!current) continue;

    if (/^    environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (/^    \S/.test(line)) {
      // Any other 4-space indented key ends the environment block.
      inEnvironment = false;
      continue;
    }

    if (inEnvironment) {
      // `      KEY: value` (list form has a leading `- ` we strip).
      const entry = /^ {6}(?:-\s*)?([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (entry) {
        current.environment[entry[1]!] = entry[2]!.trim();
      }
    }
  }

  return services;
}

function parseMysqlUrl(url: string): {
  scheme: string;
  host: string;
  port: string;
  user: string;
  database: string;
} {
  const match = /^(mysql(?:\+\w+)?:\/\/)([^:@]+):([^@]*)@([^:/]+)(?::(\d+))?\/(.+)$/.exec(
    url,
  );
  if (!match) {
    throw new Error(`unparseable DATABASE_URL (host/user/db structure): ${url}`);
  }
  return {
    scheme: match[1]!,
    user: match[2]!,
    // Password is intentionally not returned or asserted on.
    host: match[4]!,
    port: match[5] ?? "3306",
    database: match[6]!,
  };
}

test("compose - the api service's DATABASE_URL points at the mysql service, not localhost", () => {
  const services = readComposeServices(COMPOSE_PATH);
  const byName = new Map(services.map((s) => [s.name, s]));

  const api = byName.get("api");
  const mysql = byName.get("mysql");
  assert.ok(api, "docker-compose.yml must define an `api` service");
  assert.ok(mysql, "docker-compose.yml must define a `mysql` service");

  const rawUrl = api!.environment.DATABASE_URL;
  assert.ok(rawUrl, "the api service must set DATABASE_URL");

  // Resolve the same ${VAR} references compose interpolates at up time,
  // from the .env file compose itself reads, so the guard reflects the
  // URL the container actually receives.
  const envVars = readDotenv(ENV_PATH);
  const interpolate = (value: string): string =>
    value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      const resolved = envVars[name] ?? fallback ?? "";
      return resolved;
    });

  const url = parseMysqlUrl(interpolate(rawUrl));

  // The failing wiring used `localhost`, which inside a container resolves
  // to the container itself - the api could never reach MySQL that way.
  assert.equal(
    url.host,
    "mysql",
    `api DATABASE_URL must target the compose mysql service host, got "${url.host}"`,
  );

  // Port 3306 is the in-network port the mysql service listens on.
  assert.equal(url.port, "3306", "api DATABASE_URL must use the mysql service port");

  // The api must authenticate as the same user the mysql service creates
  // and open the same database it provisions.
  assert.equal(
    url.user,
    envVars.MYSQL_USER,
    "api DATABASE_URL user must match the mysql service's MYSQL_USER",
  );
  assert.equal(
    url.database,
    envVars.MYSQL_DATABASE,
    "api DATABASE_URL database must match the mysql service's MYSQL_DATABASE",
  );
});
