// @icooro/shared — cross-cutting contracts used by both apps/api and apps/web.
// This package MUST NOT depend on apps/api.

export const APP_NAME = "Icooro";
export const APP_SERVICE_API = "icooro-api";

// ---------------------------------------------------------------------------
// Enums / shared constants
// ---------------------------------------------------------------------------

export const MEDIA_TYPES = ["image", "video", "audio"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const SOURCE_KINDS = ["upload", "generated", "derived", "imported"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ASSET_LIFECYCLE_STATUSES = [
  "draft",
  "processing",
  "ready",
  "approved",
  "rejected",
  "archived",
  "failed",
] as const;
export type AssetLifecycleStatus = (typeof ASSET_LIFECYCLE_STATUSES)[number];

export const SHOT_ASSET_ROLES = [
  "reference",
  "keyframe",
  "video",
  "audio",
  "background",
  "plate",
  "vfx_element",
] as const;
export type ShotAssetRole = (typeof SHOT_ASSET_ROLES)[number];

export const JOB_STATUSES = [
  "queued",
  "submitted",
  "processing",
  "downloading",
  "completed",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Capabilities a provider adapter can implement. Mirrors the
 * ProviderCapability union in apps/api/src/providers/types.ts.
 *
 * Capabilities are deliberately explicit and enumerated: a model row must
 * declare exactly one, and the future capability-routing layer matches on
 * it. Capabilities that are not implemented are simply absent from this
 * list, so nothing in the system can claim one that does not exist.
 */
export const PROVIDER_CAPABILITIES = [
  "text",
  "image",
  "video",
  "audio",
  "vision",
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/**
 * Generation job types the production workflow supports. Used to validate
 * the `job_types` list configured on an AI model.
 *
 * Note that generation (media-producing) job types are a subset of
 * capabilities: "vision" is a *recognition* capability (image → text) and
 * therefore has no generation job type.
 */
export const GENERATION_JOB_TYPES = [
  "text-to-image",
  "text-to-video",
  "text-to-audio",
] as const;
export type GenerationJobType = (typeof GENERATION_JOB_TYPES)[number];

/**
 * The provider types the Icooro provider layer knows about (C6.7.1).
 *
 * ChatFire is one optional provider type — not the centre of the
 * architecture — alongside the OpenAI, Google Gemini and
 * custom OpenAI-compatible types the platform is being opened up to.
 *
 * `adapterAvailable` marks types whose network adapter is already
 * implemented. Only those may be selected as an adapter-backed instance;
 * the rest are reserved for later phases and are rejected at validation
 * time with an explicit message rather than silently accepted.
 */
export interface ProviderTypeDescriptor {
  readonly providerType: string;
  readonly name: string;
  readonly capabilities: readonly ProviderCapability[];
  /** True when a real adapter implementation exists for this type. */
  readonly adapterAvailable: boolean;
  /** Short human description shown in the Control Plane. */
  readonly description: string;
}

export const PROVIDER_TYPES: readonly ProviderTypeDescriptor[] = [
  {
    providerType: "openai",
    name: "OpenAI",
    capabilities: ["text", "image", "audio", "vision"],
    adapterAvailable: false,
    description: "OpenAI platform (GPT text, DALL-E image). Adapter lands in a later phase.",
  },
  {
    providerType: "google_gemini",
    name: "Google Gemini",
    capabilities: ["text", "image", "video", "audio", "vision"],
    adapterAvailable: false,
    description: "Google Gemini platform. Adapter lands in a later phase.",
  },
  {
    providerType: "custom_openai_compatible",
    name: "Custom OpenAI-compatible",
    capabilities: ["text"],
    adapterAvailable: false,
    description:
      "Any endpoint speaking the OpenAI-compatible API. Adapter lands in a later phase.",
  },
  {
    providerType: "chatfire",
    name: "ChatFire",
    capabilities: ["video"],
    adapterAvailable: true,
    description: "ChatFire Seedance video generation.",
  },
];

export const PROVIDER_TYPE_NAMES = PROVIDER_TYPES.map((t) => t.providerType) as readonly string[];

export type ProviderType = (typeof PROVIDER_TYPES)[number]["providerType"];

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && PROVIDER_TYPE_NAMES.includes(value.toLowerCase());
}

export function describeProviderType(providerType: string): ProviderTypeDescriptor | undefined {
  return PROVIDER_TYPES.find((t) => t.providerType === providerType.toLowerCase());
}
