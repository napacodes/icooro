import { providerRegistry } from "./registry.js";
import { mockMediaProvider } from "./mock.js";
import { chatfireVideoProvider } from "./chatfire.js";

export * from "./types.js";
export * from "./registry.js";
export * from "./mock.js";
export * from "./chatfire.js";

// Register default deterministic mock provider
providerRegistry.register(mockMediaProvider);
// Register real video provider (ChatFire Seedance 2.5)
providerRegistry.register(chatfireVideoProvider);
