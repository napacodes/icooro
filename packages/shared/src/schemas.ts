import { z } from "zod";
import {
  ASSET_LIFECYCLE_STATUSES,
  JOB_STATUSES,
  MEDIA_TYPES,
  SHOT_ASSET_ROLES,
  SOURCE_KINDS,
  USER_ROLES,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email("email must be a valid email"),
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(200, "password must be 200 characters or fewer"),
  name: z
    .string()
    .trim()
    .min(1, "name is required")
    .max(120, "name must be 120 characters or fewer"),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("email must be a valid email"),
  password: z.string().min(1, "password is required").max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(255),
  description: z.string().trim().nullable().optional(),
  status: z.string().trim().max(50).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().nullable().optional(),
    status: z.string().trim().min(1).max(50).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one of name, description, or status is required",
  });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// ---------------------------------------------------------------------------
// Episode / Scene / Shot / ShotVersion
// ---------------------------------------------------------------------------

export const createEpisodeSchema = z.object({
  title: z.string().trim().min(1).max(255),
  episodeNumber: z.number().int().positive(),
  status: z.string().trim().min(1).max(50).optional(),
});
export type CreateEpisodeInput = z.infer<typeof createEpisodeSchema>;

export const createSceneSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().nullable().optional(),
  orderIndex: z.number().int().positive(),
});
export type CreateSceneInput = z.infer<typeof createSceneSchema>;

export const createShotSchema = z.object({
  orderIndex: z.number().int().positive(),
  purpose: z.string().trim().max(100).nullable().optional(),
  shotType: z.string().trim().max(100).nullable().optional(),
  framing: z.string().trim().max(100).nullable().optional(),
  cameraMovement: z.string().trim().max(100).nullable().optional(),
  cameraAngle: z.string().trim().max(100).nullable().optional(),
  prompt: z.string().trim().nullable().optional(),
  visualDescription: z.string().trim().nullable().optional(),
  actionDescription: z.string().trim().nullable().optional(),
  dialogue: z.string().trim().nullable().optional(),
  transition: z.string().trim().max(100).nullable().optional(),
  productionNotes: z.string().trim().nullable().optional(),
  duration: z.number().int().nonnegative().nullable().optional(),
  status: z.string().trim().min(1).max(50).optional(),
});
export type CreateShotInput = z.infer<typeof createShotSchema>;

export const createShotVersionSchema = z.object({
  version: z.number().int().positive(),
  prompt: z.string().trim().nullable().optional(),
  status: z.string().trim().min(1).max(50).optional(),
  providerId: z.string().trim().length(36).nullable().optional(),
  modelId: z.string().trim().length(36).nullable().optional(),
  assetId: z.string().trim().length(36).nullable().optional(),
  duration: z.number().int().nonnegative().nullable().optional(),
  error: z.string().trim().nullable().optional(),
  productionReady: z.union([z.literal(0), z.literal(1)]).optional(),
});
export type CreateShotVersionInput = z.infer<typeof createShotVersionSchema>;

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

export const createAssetSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(MEDIA_TYPES),
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
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
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
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

export const createAssetVersionSchema = z.object({
  version: z.number().int().positive().optional(),
  storageKey: z.string().trim().min(1),
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
export type CreateAssetVersionInput = z.infer<typeof createAssetVersionSchema>;

export const attachShotAssetSchema = z.object({
  assetId: z.string().trim().length(36),
  assetRole: z
    .enum(SHOT_ASSET_ROLES, {
      message: `assetRole must be one of: ${SHOT_ASSET_ROLES.join(", ")}`,
    })
    .default("reference"),
});
export type AttachShotAssetInput = z.infer<typeof attachShotAssetSchema>;

// ---------------------------------------------------------------------------
// Generation job
// ---------------------------------------------------------------------------

export const createGenerationJobSchema = z.object({
  jobType: z.string().trim().min(1).max(100),
  providerId: z.string().trim().length(36).nullable().optional(),
  modelId: z.string().trim().length(36).nullable().optional(),
  episodeId: z.string().trim().length(36).nullable().optional(),
  sceneId: z.string().trim().length(36).nullable().optional(),
  shotId: z.string().trim().length(36).nullable().optional(),
  shotVersionId: z.string().trim().length(36).nullable().optional(),
  assetId: z.string().trim().length(36).nullable().optional(),
  prompt: z.string().trim().min(1).optional(),
  negativePrompt: z.string().trim().nullable().optional(),
  targetMediaType: z.enum(MEDIA_TYPES).optional(),
  requestedDuration: z.number().int().positive().nullable().optional(),
  requestedWidth: z.number().int().positive().nullable().optional(),
  requestedHeight: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CreateGenerationJobInput = z.infer<typeof createGenerationJobSchema>;

// ---------------------------------------------------------------------------
// User types
// ---------------------------------------------------------------------------

export const userRoleSchema = z.enum(USER_ROLES);
export type UserRoleInput = z.infer<typeof userRoleSchema>;

// ---------------------------------------------------------------------------
// Job status (re-exported for shared typing)
// ---------------------------------------------------------------------------

export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatusInput = z.infer<typeof jobStatusSchema>;
