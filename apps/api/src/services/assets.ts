import type {
  AssetLifecycleStatus,
  MediaType,
  ShotAssetRole,
  SourceKind,
} from "../validation/schemas.js";
import {
  type AssetDataStore,
  DrizzleAssetDataStore,
  InMemoryAssetDataStore,
} from "./asset_store.js";

export { type AssetDataStore, DrizzleAssetDataStore, InMemoryAssetDataStore };

export class AssetService {
  constructor(private readonly store: AssetDataStore = new DrizzleAssetDataStore()) {}

  /**
   * Enforces that any entity scoping (episode, scene, shot, character, location, prop)
   * strictly belongs to the same project as the asset.
   */
  async validateScoping(
    projectId: string,
    scoping: {
      episodeId?: string | null | undefined;
      sceneId?: string | null | undefined;
      shotId?: string | null | undefined;
      characterId?: string | null | undefined;
      locationId?: string | null | undefined;
      propId?: string | null | undefined;
    },
  ): Promise<string | null> {
    if (scoping.episodeId) {
      const episode = await this.store.findEpisode(scoping.episodeId);
      if (!episode || episode.projectId !== projectId) {
        return "Episode not found";
      }
    }

    if (scoping.sceneId) {
      const scene = await this.store.findScene(scoping.sceneId);
      if (!scene || scene.projectId !== projectId) {
        return "Scene not found";
      }
    }

    if (scoping.shotId) {
      const shot = await this.store.findShot(scoping.shotId);
      if (!shot || shot.projectId !== projectId) {
        return "Shot not found";
      }
    }

    if (scoping.characterId) {
      const character = await this.store.findCharacter(scoping.characterId);
      if (!character || character.projectId !== projectId) {
        return "Character not found";
      }
    }

    if (scoping.locationId) {
      const location = await this.store.findLocation(scoping.locationId);
      if (!location || location.projectId !== projectId) {
        return "Location not found";
      }
    }

    if (scoping.propId) {
      const prop = await this.store.findProp(scoping.propId);
      if (!prop || prop.projectId !== projectId) {
        return "Prop not found";
      }
    }

    return null;
  }

  async createAsset(
    projectId: string,
    input: {
      name: string;
      type: MediaType;
      description?: string | null | undefined;
      status?: AssetLifecycleStatus | undefined;
      episodeId?: string | null | undefined;
      sceneId?: string | null | undefined;
      shotId?: string | null | undefined;
      characterId?: string | null | undefined;
      locationId?: string | null | undefined;
      propId?: string | null | undefined;
      metadata?: Record<string, unknown> | null | undefined;
    },
  ) {
    const project = await this.store.findProject(projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    const scopingError = await this.validateScoping(projectId, input);
    if (scopingError) {
      throw new Error(scopingError);
    }

    const values = {
      projectId,
      name: input.name.trim(),
      type: input.type,
      description: input.description?.trim() || null,
      status: input.status ?? "draft",
      episodeId: input.episodeId ?? null,
      sceneId: input.sceneId ?? null,
      shotId: input.shotId ?? null,
      characterId: input.characterId ?? null,
      locationId: input.locationId ?? null,
      propId: input.propId ?? null,
      metadata: input.metadata ?? null,
    };

    return await this.store.createAsset(values);
  }

  async getAsset(id: string) {
    return await this.store.findAsset(id);
  }

  async getProjectAsset(projectId: string, assetId: string) {
    return await this.store.findProjectAsset(projectId, assetId);
  }

  async listProjectAssets(
    projectId: string,
    filters?: {
      type?: string | undefined;
      status?: string | undefined;
      episodeId?: string | undefined;
      shotId?: string | undefined;
      characterId?: string | undefined;
      locationId?: string | undefined;
      propId?: string | undefined;
    } | undefined,
  ) {
    return await this.store.listProjectAssets(projectId, filters);
  }

  async updateAsset(
    id: string,
    input: {
      name?: string | undefined;
      description?: string | null | undefined;
      status?: AssetLifecycleStatus | undefined;
      approvedVersionId?: string | null | undefined;
      episodeId?: string | null | undefined;
      sceneId?: string | null | undefined;
      shotId?: string | null | undefined;
      characterId?: string | null | undefined;
      locationId?: string | null | undefined;
      propId?: string | null | undefined;
      metadata?: Record<string, unknown> | null | undefined;
    },
  ) {
    const existing = await this.store.findAsset(id);
    if (!existing) throw new Error("Asset not found");

    const scopingError = await this.validateScoping(existing.projectId!, input);
    if (scopingError) throw new Error(scopingError);

    if (input.approvedVersionId) {
      const version = await this.store.findVersionById(input.approvedVersionId);
      if (!version || version.assetId !== id) {
        throw new Error("Approved version does not belong to this asset");
      }
    }

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined) updates.description = input.description?.trim() || null;
    if (input.status !== undefined) updates.status = input.status;
    if (input.approvedVersionId !== undefined) updates.approvedVersionId = input.approvedVersionId;
    if (input.episodeId !== undefined) updates.episodeId = input.episodeId;
    if (input.sceneId !== undefined) updates.sceneId = input.sceneId;
    if (input.shotId !== undefined) updates.shotId = input.shotId;
    if (input.characterId !== undefined) updates.characterId = input.characterId;
    if (input.locationId !== undefined) updates.locationId = input.locationId;
    if (input.propId !== undefined) updates.propId = input.propId;
    if (input.metadata !== undefined) updates.metadata = input.metadata;

    return await this.store.updateAsset(id, updates);
  }

  async deleteAsset(id: string) {
    return await this.store.deleteAsset(id);
  }

  async createVersion(
    assetId: string,
    input: {
      version?: number | undefined;
      storageKey: string;
      sourceKind?: SourceKind | undefined;
      status?: AssetLifecycleStatus | undefined;
      mimeType?: string | null | undefined;
      fileExtension?: string | null | undefined;
      fileSize?: number | null | undefined;
      checksum?: string | null | undefined;
      width?: number | null | undefined;
      height?: number | null | undefined;
      duration?: number | null | undefined;
      fps?: number | null | undefined;
      sampleRate?: number | null | undefined;
      channels?: number | null | undefined;
      codec?: string | null | undefined;
      prompt?: string | null | undefined;
      negativePrompt?: string | null | undefined;
      jobId?: string | null | undefined;
      metadata?: Record<string, unknown> | null | undefined;
    },
  ) {
    const asset = await this.store.findAsset(assetId);
    if (!asset) throw new Error("Asset not found");

    let targetVersion = input.version;
    if (targetVersion === undefined) {
      const existingVersions = await this.store.listVersions(assetId);
      targetVersion =
        existingVersions.length > 0
          ? Math.max(...existingVersions.map((v) => v.version)) + 1
          : 1;
    } else {
      const duplicate = await this.store.findVersion(assetId, targetVersion);
      if (duplicate) {
        throw new Error("Asset version already exists");
      }
    }

    const versionValues = {
      assetId,
      version: targetVersion,
      status: input.status ?? "ready",
      sourceKind: input.sourceKind ?? "upload",
      storageKey: input.storageKey.trim(),
      mimeType: input.mimeType ?? null,
      fileExtension: input.fileExtension ?? null,
      fileSize: input.fileSize ?? null,
      checksum: input.checksum ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      duration: input.duration ?? null,
      fps: input.fps ?? null,
      sampleRate: input.sampleRate ?? null,
      channels: input.channels ?? null,
      codec: input.codec ?? null,
      prompt: input.prompt ?? null,
      negativePrompt: input.negativePrompt ?? null,
      jobId: input.jobId ?? null,
      metadata: input.metadata ?? null,
    };

    const row = await this.store.createVersion(versionValues);

    if (asset.status === "draft") {
      await this.store.updateAsset(assetId, { status: "ready" });
    }

    return row;
  }

  async listVersions(assetId: string) {
    const asset = await this.store.findAsset(assetId);
    if (!asset) throw new Error("Asset not found");
    return await this.store.listVersions(assetId);
  }

  async getVersion(assetId: string, versionIdOrNumber: string | number) {
    return await this.store.findVersion(assetId, versionIdOrNumber);
  }

  async approveVersion(assetId: string, versionId: string) {
    const version = await this.store.findVersion(assetId, versionId);
    if (!version) throw new Error("Asset version not found");

    await this.store.resetApprovedVersions(assetId);
    await this.store.updateVersion(versionId, { status: "approved" });
    await this.store.updateAsset(assetId, {
      approvedVersionId: versionId,
      status: "approved",
    });

    const updatedVersion = await this.store.findVersionById(versionId);
    const updatedAsset = await this.store.findAsset(assetId);

    return { version: updatedVersion, asset: updatedAsset };
  }

  async rejectVersion(assetId: string, versionId: string) {
    const version = await this.store.findVersion(assetId, versionId);
    if (!version) throw new Error("Asset version not found");

    await this.store.updateVersion(versionId, { status: "rejected" });

    const asset = await this.store.findAsset(assetId);
    if (asset?.approvedVersionId === versionId) {
      await this.store.updateAsset(assetId, {
        approvedVersionId: null,
        status: "ready",
      });
    }

    return await this.store.findVersionById(versionId);
  }

  async attachAssetToShot(
    shotId: string,
    assetId: string,
    assetRole: ShotAssetRole | string = "reference",
  ) {
    const shotRow = await this.store.findShot(shotId);
    if (!shotRow) throw new Error("Shot not found");

    const asset = await this.store.findAsset(assetId);
    if (!asset) throw new Error("Asset not found");

    if (asset.projectId !== shotRow.projectId) {
      throw new Error("Asset not found");
    }

    const existing = await this.store.findShotAsset(shotId, assetId);
    if (existing) {
      throw new Error("Asset is already attached to this shot");
    }

    return await this.store.createShotAsset({ shotId, assetId, assetRole });
  }

  async detachAssetFromShot(shotId: string, assetId: string) {
    return await this.store.deleteShotAsset(shotId, assetId);
  }

  async listShotAssets(shotId: string) {
    const shot = await this.store.findShot(shotId);
    if (!shot) throw new Error("Shot not found");
    return await this.store.listShotAssets(shotId);
  }
}

export const assetService = new AssetService();
