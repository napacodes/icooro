import { config } from "dotenv";

config({ path: "../../.env" });

function readPort(): number {
  const raw = process.env.API_PORT ?? "3001";
  const port = Number(raw);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port");
  }

  return port;
}

function readDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url || url.trim() === "") {
    throw new Error("DATABASE_URL is required");
  }

  return url;
}

function readStorageDriver(): string {
  return process.env.STORAGE_DRIVER ?? "local";
}

function readStorageLocalRoot(): string {
  return process.env.STORAGE_LOCAL_ROOT ?? "./storage";
}

function readChatFireBaseUrl(): string {
  return process.env.CHATFIRE_BASE_URL ?? "https://api.chatfire.site";
}

function readChatFireApiKey(): string {
  return process.env.CHATFIRE_API_KEY ?? "";
}

/**
 * Browser origins allowed to call the API with credentials.
 *
 * Comma-separated, e.g. `http://localhost:3000,http://192.168.1.49:3000`.
 * When unset, only the local development origin is allowed. Origins are
 * echoed per-request, never wildcarded, so `credentials: true` stays valid.
 */
const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

export function parseCorsOrigins(
  raw: string | undefined,
  fallback = DEFAULT_CORS_ORIGIN,
): string[] {
  if (!raw || raw.trim() === "") return [fallback];
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  return origins.length > 0 ? origins : [fallback];
}

export const env = {
  port: readPort(),
  databaseUrl: readDatabaseUrl(),
  storageDriver: readStorageDriver(),
  storageLocalRoot: readStorageLocalRoot(),
  chatfireBaseUrl: readChatFireBaseUrl(),
  chatfireApiKey: readChatFireApiKey(),
  corsOrigins: parseCorsOrigins(process.env.API_CORS_ORIGINS),
};
