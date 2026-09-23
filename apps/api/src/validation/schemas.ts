// Local Zod schemas re-exported from @icooro/shared.
// The API uses the same schemas as the frontend to keep contracts in sync.
// Future domain-specific schemas (admin-only, etc.) can be added here.

export {
  ASSET_LIFECYCLE_STATUSES,
  JOB_STATUSES,
  MEDIA_TYPES,
  SHOT_ASSET_ROLES,
  SOURCE_KINDS,
  USER_ROLES,
  // types
  type AssetLifecycleStatus,
  type JobStatus,
  type MediaType,
  type ShotAssetRole,
  type SourceKind,
  type UserRole,
  // schemas
  attachShotAssetSchema,
  createAssetSchema,
  createAssetVersionSchema,
  createGenerationJobSchema,
  createProjectSchema,
  createShotSchema,
  createShotVersionSchema,
  createEpisodeSchema,
  createSceneSchema,
  jobStatusSchema,
  loginSchema,
  signupSchema,
  updateAssetSchema,
  updateProjectSchema,
  userRoleSchema,
  adminUpdateUserSchema,
  adminUpdateProviderSchema,
  adminUpdateModelSchema,
  adminCreateProviderSchema,
  adminCreateModelSchema,
  // input types
  type SignupInput,
  type LoginInput,
  type CreateProjectInput,
  type UpdateProjectInput,
  type CreateEpisodeInput,
  type CreateSceneInput,
  type CreateShotInput,
  type CreateShotVersionInput,
  type CreateAssetInput,
  type UpdateAssetInput,
  type CreateAssetVersionInput,
  type AttachShotAssetInput,
  type CreateGenerationJobInput,
  type AdminUpdateUserInput,
  type AdminUpdateProviderInput,
  type AdminUpdateModelInput,
  type AdminCreateProviderInput,
  type AdminCreateModelInput,
} from "@icooro/shared";

import type { ZodError } from "zod";

export function formatZodError(error: ZodError): {
  error: { code: string; message: string };
} {
  const firstIssue = error.issues[0];
  const message = firstIssue ? firstIssue.message : "Validation failed";
  return {
    error: {
      code: "INVALID_REQUEST",
      message,
    },
  };
}
