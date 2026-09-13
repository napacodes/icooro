import { providerRegistry } from "./registry.js";
import { mockMediaProvider } from "./mock.js";

export * from "./types.js";
export * from "./registry.js";
export * from "./mock.js";

// Register default deterministic mock provider
providerRegistry.register(mockMediaProvider);
