import type {
  AudioProvider,
  BaseProvider,
  ImageProvider,
  ProviderCapability,
  TextProvider,
  VideoProvider,
} from "./types.js";
import { ProviderError } from "./types.js";
import { providerRegistry } from "./registry.js";
import { hasSecret, providerSecretStore } from "./secrets.js";

/**
 * Provider adapter factory (C6.3).
 *
 * The registry in `registry.ts` holds process-wide *singletons* keyed by
 * provider type; it is how C5.1 wired the ChatFire and mock adapters. It
 * cannot express "one configured instance per database provider record",
 * which is what an admin-managed provider needs (each record carries its own
 * base URL and API key).
 *
 * This module adds that smallest possible layer on top: a map from adapter
 * type to a *factory* that builds a configured adapter instance from a
 * provider record. Resolution order is:
 *
 *   1. registered factory  → build a fresh, record-configured instance
 *   2. registry singleton  → internal/dev adapters (e.g. the deterministic
 *      mock used by C5.2/C5.3 tests), preserving existing behaviour
 *
 * Nothing else about the provider abstraction changes: adapters still
 * implement the VideoProvider/ImageProvider/... interfaces from types.ts,
 * and capability checks stay exactly as they were.
 */

export interface ProviderAdapterConfig {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
  fetchFn?: typeof fetch;
}

export type AdapterFactory = (config: ProviderAdapterConfig) => BaseProvider;

export interface AdapterTypeInfo {
  providerType: string;
  name: string;
  capabilities: readonly ProviderCapability[];
}

interface AdapterTypeRegistration extends AdapterTypeInfo {
  factory: AdapterFactory;
}

const adapterFactories = new Map<string, AdapterTypeRegistration>();

function normType(providerType: string): string {
  return (providerType ?? "").toLowerCase();
}

/**
 * Registers a configurable adapter type, e.g. "chatfire".
 * Exported so `providers/index.ts` is the single registration site.
 */
export function registerAdapterFactory(
  providerType: string,
  name: string,
  capabilities: readonly ProviderCapability[],
  factory: AdapterFactory,
): void {
  adapterFactories.set(normType(providerType), {
    providerType: normType(providerType),
    name,
    capabilities,
    factory,
  });
}

export function getAdapterFactory(providerType: string): AdapterFactory | undefined {
  return adapterFactories.get(normType(providerType))?.factory;
}

/**
 * The adapter types an admin can configure. Only factory-backed types are
 * listed: those are the ones that can be built from a provider record's
 * credentials. Registry singletons (mock/dev adapters) are intentionally
 * internal and not admin-selectable.
 *
 * NOTE: this describes the *adapter* layer only (what can be constructed).
 * The full provider-type catalog — including reserved types whose adapter
 * has not landed yet — lives in `types_catalog.ts`. The Admin Control Plane
 * lists from that catalog; this list is kept for backwards compatibility
 * with existing callers.
 */
export function listAdapterTypes(): AdapterTypeInfo[] {
  return Array.from(adapterFactories.values()).map(({ factory: _factory, ...info }) => info);
}

/**
 * True when this type has a *constructible* adapter: either a registered
 * factory, or a process-wide registry singleton (mock/dev adapters and any
 * pre-C6.3 provider record).
 */
export function isKnownAdapterType(providerType: string): boolean {
  return (
    adapterFactories.has(normType(providerType)) ||
    providerRegistry.get(providerType) !== undefined
  );
}

/**
 * True when the type can be *configured* in the Control Plane. That is the
 * case for every type in the provider architecture whose adapter exists —
 * the set the admin UI builds its type selector from.
 */
export function isConfigurableAdapterType(providerType: string): boolean {
  return adapterFactories.has(normType(providerType));
}

/**
 * Unseals the provider record's API key. A missing or unreadable envelope
 * yields `undefined` rather than throwing: the adapter then reports its own
 * "API key not configured" error through the normal ProviderError path,
 * which the generation services already handle. This keeps the secret out
 * of error messages and avoids a 500 on a misconfigured row.
 */
function safeRevealApiKey(envelope: string | null | undefined): string | undefined {
  if (!hasSecret(envelope)) return undefined;
  try {
    return providerSecretStore.reveal(envelope as string);
  } catch {
    return undefined;
  }
}

/**
 * Subset of a provider DB row that adapter resolution needs.
 * Kept structural so callers can pass raw Drizzle rows (whose JSON columns
 * are typed `unknown`).
 */
export interface ProviderRecordLike {
  providerType: string;
  baseUrl?: string | null;
  apiKeySecret?: string | null;
  config?: unknown;
}

export function adapterConfigFromRecord(record: ProviderRecordLike): ProviderAdapterConfig {
  // Only set keys that have a value: under exactOptionalPropertyTypes an
  // explicit `undefined` is not assignable to an optional property.
  const config: ProviderAdapterConfig = {};
  if (record.baseUrl) {
    config.baseUrl = record.baseUrl;
  }
  const apiKey = safeRevealApiKey(record.apiKeySecret);
  if (apiKey !== undefined) {
    config.apiKey = apiKey;
  }
  return config;
}

/**
 * Resolves a usable adapter for a provider record, or `undefined` when the
 * type is unknown or the adapter does not support the requested capability.
 */
export function resolveAdapter(
  record: ProviderRecordLike,
  capability: ProviderCapability,
): BaseProvider | undefined {
  const type = normType(record.providerType);

  const registration = adapterFactories.get(type);
  if (registration) {
    if (!registration.capabilities.includes(capability)) return undefined;
    // Construction can fail for types whose configuration contract is
    // stricter than the schema (e.g. the custom OpenAI-compatible adapter
    // requires a base URL). A misconfigured record then degrades to "no
    // usable adapter" — the same philosophy as safeRevealApiKey above —
    // instead of throwing out of resolution.
    try {
      return registration.factory(adapterConfigFromRecord(record));
    } catch (err) {
      // Configuration-invalid records (stricter per-type constructor
      // contracts than the schema enforces, e.g. the custom
      // OpenAI-compatible adapter's required base URL) degrade to "no
      // usable adapter" — the same philosophy as safeRevealApiKey above.
      // Anything else is a programmer bug or invariant violation and must
      // stay loud rather than masquerade as a missing adapter.
      if (!(err instanceof ProviderError)) throw err;
      return undefined;
    }
  }

  // Fallback: process-wide registry singleton (mock/dev adapters and any
  // pre-C6.3 provider record).
  const singleton = providerRegistry.get(type);
  if (!singleton || !singleton.capabilities.includes(capability)) return undefined;
  return singleton;
}

export function resolveVideoProvider(record: ProviderRecordLike): VideoProvider | undefined {
  return resolveAdapter(record, "video") as VideoProvider | undefined;
}

export function resolveImageProvider(record: ProviderRecordLike): ImageProvider | undefined {
  return resolveAdapter(record, "image") as ImageProvider | undefined;
}

export function resolveAudioProvider(record: ProviderRecordLike): AudioProvider | undefined {
  return resolveAdapter(record, "audio") as AudioProvider | undefined;
}

export function resolveTextProvider(record: ProviderRecordLike): TextProvider | undefined {
  return resolveAdapter(record, "text") as TextProvider | undefined;
}
