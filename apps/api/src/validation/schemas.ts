import { z, type ZodError } from "zod";

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

export const createAssetSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(255, "name must be 255 characters or fewer"),
  type: z.enum(MEDIA_TYPES, {
    message: "type must be one of: image, video, audio",
  }),
  description: z.string().trim().nullable().optional(),
  status: z.enum(ASSET_LIFECYCLE_STATUSES).default("draft"),
  episodeId: z.string().trim().length(36).nullable().optional(),
  sceneId: z.string().trim().length(36).nullable().optional(),
  shotId: z.string().trim().length(36).nullable().optional(),
  characterId: z.string().trim().length(36).nullable().optional(),
  locationId: z.string().trim().length(36).nullable().optional(),
  propId: z.string().trim().length(36).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(1, "name must be non-empty").max(255).optional(),
    description: z.string().trim().nullable().optional(),
    status: z.enum(ASSET_LIFECYCLE_STATUSES).optional(),
    episodeId: z.string().trim().length(36).nullable().optional(),
    sceneId: z.string().trim().length(36).nullable().optional(),
    shotId: z.string().trim().length(36).nullable().optional(),
    characterId: z.string().trim().length(36).nullable().optional(),
    locationId: z.string().trim().length(36).nullable().optional(),
    propId: z.string().trim().length(36).nullable().optional(),
    approvedVersionId: z.string().trim().length(36).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required for update",
  });

export const createAssetVersionSchema = z.object({
  version: z.number().int().positive("version must be a positive integer").optional(),
  storageKey: z.string().trim().min(1, "storageKey is required"),
  sourceKind: z.enum(SOURCE_KINDS).default("upload"),
  status: z.enum(ASSET_LIFECYCLE_STATUSES).default("ready"),
  mimeType: z.string().trim().max(255).nullable().optional(),
  fileExtension: z.string().trim().max(20).nullable().optional(),
  fileSize: z.number().int().nonnegative().nullable().optional(),
  checksum: z.string().trim().max(128).nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  duration: z.number().int().nonnegative().nullable().optional(),
  fps: z.number().int().positive().nullable().optional(),
  sampleRate: z.number().int().positive().nullable().optional(),
  channels: z.number().int().positive().nullable().optional(),
  codec: z.string().trim().max(100).nullable().optional(),
  prompt: z.string().trim().nullable().optional(),
  negativePrompt: z.string().trim().nullable().optional(),
  jobId: z.string().trim().length(36).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

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

export const attachShotAssetSchema = z.object({
  assetId: z.string().trim().length(36, "assetId must be a valid 36-character ID"),
  assetRole: z
    .enum(SHOT_ASSET_ROLES, {
      message: `assetRole must be one of: ${SHOT_ASSET_ROLES.join(", ")}`,
    })
    .default("reference"),
});

export const createGenerationJobSchema = z.object({
  jobType: z.string().trim().min(1, "jobType is required").max(100),
  providerId: z.string().trim().length(36).nullable().optional(),
  modelId: z.string().trim().length(36).nullable().optional(),
  episodeId: z.string().trim().length(36).nullable().optional(),
  sceneId: z.string().trim().length(36).nullable().optional(),
  shotId: z.string().trim().length(36).nullable().optional(),
  shotVersionId: z.string().trim().length(36).nullable().optional(),
  assetId: z.string().trim().length(36).nullable().optional(),
  prompt: z.string().trim().min(1, "prompt is required").optional(),
  negativePrompt: z.string().trim().nullable().optional(),
  targetMediaType: z.enum(MEDIA_TYPES).optional(),
  requestedDuration: z.number().int().positive().nullable().optional(),
  requestedWidth: z.number().int().positive().nullable().optional(),
  requestedHeight: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export function formatZodError(error: ZodError): { error: { code: string; message: string } } {
  const firstIssue = error.issues[0];
  const message = firstIssue ? firstIssue.message : "Validation failed";
  return {
    error: {
      code: "INVALID_REQUEST",
      message,
    },
  };
}
