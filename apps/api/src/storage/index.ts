import { env } from "../env.js";
import { LocalStorageProvider } from "./local.js";
import type { StorageProvider } from "./types.js";

export * from "./types.js";
export * from "./local.js";

let defaultStorageProvider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (!defaultStorageProvider) {
    if (env.storageDriver === "local") {
      defaultStorageProvider = new LocalStorageProvider(env.storageLocalRoot);
    } else {
      throw new Error(`Unsupported storage driver: "${env.storageDriver}"`);
    }
  }

  return defaultStorageProvider;
}

export function setStorageProvider(provider: StorageProvider | null): void {
  defaultStorageProvider = provider;
}
