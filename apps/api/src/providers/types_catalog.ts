/**
 * Provider type catalog (C6.7.1 — Provider Architecture Foundation).
 *
 * This module is the API-side authority on which provider *types* exist:
 *
 *     openai | google_gemini | custom_openai_compatible | chatfire
 *
 * It is deliberately separate from `factory.ts`. `factory.ts` is about
 * *adapter construction* — turning a provider record into a live, configured
 * adapter instance. Only types whose network adapter already exists are
 * registered there. This catalog is about the *architecture*: which types
 * the platform is being opened up to, what human name they carry, and which
 * capabilities each one can ultimately serve. It is the single source of
 * truth that the Admin Control Plane lists in its provider-type selector and
 * that validation checks provider records against.
 *
 * ChatFire is one entry here — the only one with `adapterAvailable: true` —
 * not the centre of the architecture. The OpenAI / Gemini /
 * custom-OpenAI-compatible types are reserved: the Control Plane can
 * reference them (so the roadmap is visible and the schema stays stable),
 * but a provider record of such a type cannot be given credentials and used
 * until its adapter lands in a later phase.
 */

import {
  PROVIDER_TYPES,
  describeProviderType,
  isProviderType,
  type ProviderCapability,
  type ProviderType,
  type ProviderTypeDescriptor,
} from "@icooro/shared";

export {
  isProviderType,
  describeProviderType,
  PROVIDER_TYPES,
  type ProviderCapability,
  type ProviderType,
  type ProviderTypeDescriptor,
};

/**
 * Types an admin can pick when configuring a provider record.
 *
 * All known types are selectable — including the ones whose adapter is not
 * built yet — so the Control Plane can model the intended provider fleet
 * ahead of the adapter work. `adapterAvailable` is exposed per type so the
 * UI can flag "adapter coming soon" and the submit path can reject an
 * attempt to *run a generation* against a type that cannot serve it.
 */
export function listProviderTypes(): ProviderTypeDescriptor[] {
  return PROVIDER_TYPES.map((t) => ({ ...t, capabilities: [...t.capabilities] }));
}

/** True when the type is part of the Icoooro provider architecture. */
export function isKnownProviderType(providerType: string): boolean {
  return isProviderType(providerType);
}

/**
 * True when a real adapter implementation exists for this type, i.e. the
 * type can actually be given credentials and used to generate.
 */
export function isAdaptableProviderType(providerType: string): boolean {
  return describeProviderType(providerType)?.adapterAvailable ?? false;
}

/** Capabilities declared for a type, or `undefined` for an unknown type. */
export function capabilitiesForType(providerType: string): readonly ProviderCapability[] {
  return describeProviderType(providerType)?.capabilities ?? [];
}

/**
 * The type names this catalog knows about. Used by the Control Plane to
 * label reserved types and by validation to produce clear errors.
 */
export const KNOWN_PROVIDER_TYPES: readonly ProviderType[] = PROVIDER_TYPES.map(
  (t) => t.providerType,
);

/** Human label for a type, falling back to the raw value for unknown types. */
export function providerTypeLabel(providerType: string): string {
  return describeProviderType(providerType)?.name ?? providerType;
}

/**
 * Per-type provider configuration validation (C6.8.3a).
 *
 * The admin schema accepts a record for any adaptable type, but a few adapter
 * types have stricter construction contracts than a body-only schema can
 * express: the custom OpenAI-compatible adapter has NO default host of any
 * kind, so its base URL is required. This is the single reusable check the
 * create and update routes run so a record that could never construct a
 * usable adapter is rejected at the API boundary instead of degrading
 * silently to "no usable adapter" at generation time.
 *
 * Returns `null` when the configuration is acceptable, otherwise a clear
 * human-readable message for the 400 response. Future per-type requirements
 * belong in this function — keep it the only place that knows which fields
 * each provider type requires.
 */
const TYPES_REQUIRING_BASE_URL: ReadonlySet<string> = new Set(["custom_openai_compatible"]);

export function providerConfigProblem(
  providerType: string,
  baseUrl: string | null | undefined,
): string | null {
  const type = (providerType ?? "").toLowerCase();
  if (TYPES_REQUIRING_BASE_URL.has(type) && (baseUrl?.trim() ?? "") === "") {
    return `A base URL is required for the "${type}" provider type — configure the gateway endpoint on the provider record.`;
  }
  // chatfire / openai / google_gemini construct with vendor defaults (and
  // ChatFire additionally falls back to env), so they have no required
  // fields today. apiKey is deliberately never required here: the adapters'
  // environment fallback is an established contract.
  return null;
}

/**
 * Reason a provider record of this type cannot currently be used, or `null`
 * when it is usable. The only unusable-by-design case today is a type whose
 * adapter has not landed yet.
 */
export function providerTypeNotAdaptableReason(providerType: string): string | null {
  const descriptor = describeProviderType(providerType);
  if (!descriptor) {
    return `Unknown provider type "${providerType}" — it is not part of the Icooro provider architecture`;
  }
  if (!descriptor.adapterAvailable) {
    return `Provider type "${descriptor.name}" is reserved: its adapter is not implemented yet (planned for a later phase)`;
  }
  return null;
}
