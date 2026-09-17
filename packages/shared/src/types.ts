// Shared entity type contracts. These mirror the Drizzle schema shapes
// in `apps/api/src/db/schema/*` and the API response envelopes. They are
// the contract both apps agree on; do not put API implementation details
// here.

import type {
  MediaType,
  ShotAssetRole,
  AssetLifecycleStatus,
  SourceKind,
  JobStatus,
  UserRole,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Storytelling: Episode, Scene, Shot, ShotVersion
// ---------------------------------------------------------------------------

export interface Episode {
  id: string;
  projectId: string;
  title: string;
  episodeNumber: number;
  status: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  id: string;
  episodeId: string;
  name: string;
  description: string | null;
  orderIndex: number;
}

export interface Shot {
  id: string;
  sceneId: string;
  orderIndex: number;
  purpose: string | null;
  shotType: string | null;
  framing: string | null;
  cameraMovement: string | null;
  cameraAngle: string | null;
  prompt: string | null;
  visualDescription: string | null;
  actionDescription: string | null;
  dialogue: string | null;
  transition: string | null;
  productionNotes: string | null;
  duration: number | null;
  status: string;
}

export interface ShotVersion {
  id: string;
  shotId: string;
  version: number;
  prompt: string | null;
  status: string;
  providerId: string | null;
  modelId: string | null;
  assetId: string | null;
  duration: number | null;
  error: string | null;
  productionReady: 0 | 1;
}

// ---------------------------------------------------------------------------
// Media assets
// ---------------------------------------------------------------------------

export interface Asset {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  type: MediaType;
  status: AssetLifecycleStatus;
  approvedVersionId: string | null;
  episodeId: string | null;
  sceneId: string | null;
  shotId: string | null;
  characterId: string | null;
  locationId: string | null;
  propId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetVersion {
  id: string;
  assetId: string;
  version: number;
  status: AssetLifecycleStatus;
  sourceKind: SourceKind;
  storageKey: string;
  fileExtension: string | null;
  mimeType: string | null;
  fileSize: number | null;
  checksum: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  fps: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  jobId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Generation jobs
// ---------------------------------------------------------------------------

export interface GenerationJob {
  id: string;
  projectId: string;
  jobType: string;
  status: JobStatus;
  providerId: string | null;
  modelId: string | null;
  externalJobId: string | null;
  episodeId: string | null;
  sceneId: string | null;
  shotId: string | null;
  shotVersionId: string | null;
  assetId: string | null;
  assetVersionId: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  targetMediaType: MediaType | null;
  requestedDuration: number | null;
  requestedWidth: number | null;
  requestedHeight: number | null;
  progress: number;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}
