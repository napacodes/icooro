import { providerRegistry } from "./registry.js";
import { mockMediaProvider } from "./mock.js";
import { ChatFireVideoProvider, chatfireVideoProvider } from "./chatfire.js";
import { OpenAITextProvider } from "./openai.js";
import { GeminiTextProvider } from "./gemini.js";
import { CustomOpenAICompatibleTextProvider } from "./custom_openai_compatible.js";
import { registerAdapterFactory } from "./factory.js";

export * from "./types.js";
export * from "./registry.js";
export * from "./mock.js";
export * from "./chatfire.js";
export * from "./openai.js";
export * from "./gemini.js";
export * from "./custom_openai_compatible.js";
export * from "./secrets.js";
export * from "./factory.js";
export * from "./dto.js";
// The catalog re-exports a few shared constants/types (PROVIDER_TYPES,
// ProviderCapability, ...) that `types.ts` also defines, so export it
// explicitly-named to avoid an ambiguous re-export.
export {
  capabilitiesForType,
  isAdaptableProviderType,
  isKnownProviderType,
  isProviderType,
  describeProviderType,
  listProviderTypes,
  providerTypeLabel,
  providerTypeNotAdaptableReason,
  KNOWN_PROVIDER_TYPES,
  PROVIDER_TYPES,
  type ProviderType,
  type ProviderTypeDescriptor,
} from "./types_catalog.js";
export * from "./capabilities.js";

// Register deterministic mock provider (used by C5.2/C5.3 tests; an
// internal registry singleton, not an admin-selectable adapter type).
providerRegistry.register(mockMediaProvider);

// Register the real video adapter (C5.1). This stays a process-wide
// singleton so existing C5 code paths keep working unchanged.
providerRegistry.register(chatfireVideoProvider);

// Register configurable adapter types (C6.3). Each admin-created provider
// record of one of these types resolves to a fresh, record-configured
// adapter instance carrying that record's base URL and unsealed API key.
//
// All four catalog types now have adapters: ChatFire (C5.1), OpenAI text
// (C6.7.2.1), Google Gemini text (C6.7.2.2), and the custom
// OpenAI-compatible text adapter (C6.7.2.3).
registerAdapterFactory(
  "chatfire",
  "ChatFire Seedance 2.5",
  ["video"],
  (config) => new ChatFireVideoProvider(config),
);
registerAdapterFactory(
  "openai",
  "OpenAI",
  ["text"],
  (config) => new OpenAITextProvider(config),
);
registerAdapterFactory(
  "google_gemini",
  "Google Gemini",
  ["text"],
  (config) => new GeminiTextProvider(config),
);
registerAdapterFactory(
  "custom_openai_compatible",
  "Custom OpenAI-compatible",
  ["text"],
  (config) => new CustomOpenAICompatibleTextProvider(config),
);
