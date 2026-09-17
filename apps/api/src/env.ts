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

export const env = {
  port: readPort(),
  databaseUrl: readDatabaseUrl(),
  storageDriver: readStorageDriver(),
  storageLocalRoot: readStorageLocalRoot(),
  chatfireBaseUrl: readChatFireBaseUrl(),
  chatfireApiKey: readChatFireApiKey(),
};
