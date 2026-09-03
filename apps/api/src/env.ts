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

export const env = {
  port: readPort(),
  databaseUrl: readDatabaseUrl(),
};