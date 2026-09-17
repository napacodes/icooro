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
