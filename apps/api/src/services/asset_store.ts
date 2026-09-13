import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { assets } from "../db/schema/assets.js";
import { assetVersions } from "../db/schema/asset_versions.js";
import { shotAssets } from "../db/schema/shot_assets.js";
import { projects } from "../db/schema/projects.js";
import { episodes } from "../db/schema/episodes.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { characters } from "../db/schema/characters.js";
import { locations } from "../db/schema/locations.js";
import { props } from "../db/schema/props.js";

export interface AssetDataStore {
  // Scoping entity lookups
  findProject(id: string): Promise<{ id: string } | null>;
  findEpisode(id: string): Promise<{ id: string; projectId: string } | null>;
  findScene(id: string): Promise<{ id: string; projectId: string } | null>;
  findShot(id: string): Promise<{ id: string; projectId: string } | null>;
  findCharacter(id: string): Promise<{ id: string; projectId: string } | null>;
  findLocation(id: string): Promise<{ id: string; projectId: string } | null>;
  findProp(id: string): Promise<{ id: string; projectId: string } | null>;

  // Assets
  createAsset(values: any): Promise<any>;
  findAsset(id: string): Promise<any | null>;
  findProjectAsset(projectId: string, id: string): Promise<any | null>;
  listProjectAssets(projectId: string, filters?: Record<string, string | undefined>): Promise<any[]>;
  updateAsset(id: string, updates: Record<string, unknown>): Promise<any>;
  deleteAsset(id: string): Promise<boolean>;

  // Asset Versions
  createVersion(values: any): Promise<any>;
  listVersions(assetId: string): Promise<any[]>;
  findVersion(assetId: string, versionIdOrNumber: string | number): Promise<any | null>;
  findVersionById(id: string): Promise<any | null>;
  updateVersion(id: string, updates: Record<string, unknown>): Promise<any>;
  resetApprovedVersions(assetId: string): Promise<void>;

  // Shot Assets
  findShotAsset(shotId: string, assetId: string): Promise<any | null>;
  createShotAsset(values: { shotId: string; assetId: string; assetRole: string }): Promise<any>;
  deleteShotAsset(shotId: string, assetId: string): Promise<boolean>;
  listShotAssets(shotId: string): Promise<any[]>;
}

export class DrizzleAssetDataStore implements AssetDataStore {
  async findProject(id: string) {
    const [row] = await getDb()
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, id));
    return row ?? null;
  }

  async findEpisode(id: string) {
    const [row] = await getDb()
      .select({ id: episodes.id, projectId: episodes.projectId })
      .from(episodes)
      .where(eq(episodes.id, id));
    return row ?? null;
  }

  async findScene(id: string) {
    const [row] = await getDb()
      .select({ id: scenes.id, projectId: episodes.projectId })
      .from(scenes)
      .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
      .where(eq(scenes.id, id));
    return row ?? null;
  }

  async findShot(id: string) {
    const [row] = await getDb()
      .select({ id: shots.id, projectId: episodes.projectId })
      .from(shots)
      .innerJoin(scenes, eq(shots.sceneId, scenes.id))
      .innerJoin(episodes, eq(scenes.episodeId, episodes.id))
      .where(eq(shots.id, id));
    return row ?? null;
  }

  async findCharacter(id: string) {
    const [row] = await getDb()
      .select({ id: characters.id, projectId: characters.projectId })
      .from(characters)
      .where(eq(characters.id, id));
    return row ?? null;
  }

  async findLocation(id: string) {
    const [row] = await getDb()
      .select({ id: locations.id, projectId: locations.projectId })
      .from(locations)
      .where(eq(locations.id, id));
    return row ?? null;
  }

  async findProp(id: string) {
    const [row] = await getDb()
      .select({ id: props.id, projectId: props.projectId })
      .from(props)
      .where(eq(props.id, id));
    return row ?? null;
  }

  async createAsset(values: any) {
    const db = getDb();
    const [created] = await db.insert(assets).values(values).$returningId();
    if (!created) throw new Error("Failed to create asset");
    const [asset] = await db.select().from(assets).where(eq(assets.id, created.id));
    return asset;
  }

  async findAsset(id: string) {
    const [row] = await getDb().select().from(assets).where(eq(assets.id, id));
    return row ?? null;
  }

  async findProjectAsset(projectId: string, id: string) {
    const [row] = await getDb()
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.projectId, projectId)));
    return row ?? null;
  }

  async listProjectAssets(projectId: string, filters?: Record<string, string | undefined>) {
    const conditions = [eq(assets.projectId, projectId)];
    if (filters?.type) conditions.push(eq(assets.type, filters.type));
    if (filters?.status) conditions.push(eq(assets.status, filters.status));
    if (filters?.episodeId) conditions.push(eq(assets.episodeId, filters.episodeId));
    if (filters?.shotId) conditions.push(eq(assets.shotId, filters.shotId));
    if (filters?.characterId) conditions.push(eq(assets.characterId, filters.characterId));
    if (filters?.locationId) conditions.push(eq(assets.locationId, filters.locationId));
    if (filters?.propId) conditions.push(eq(assets.propId, filters.propId));

    return await getDb()
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(desc(assets.createdAt));
  }

  async updateAsset(id: string, updates: Record<string, unknown>) {
    const db = getDb();
    await db.update(assets).set(updates).where(eq(assets.id, id));
    const [updated] = await db.select().from(assets).where(eq(assets.id, id));
    return updated;
  }

  async deleteAsset(id: string) {
    const result = await getDb().delete(assets).where(eq(assets.id, id));
    return result[0].affectedRows > 0;
  }

  async createVersion(values: any) {
    const db = getDb();
    const [created] = await db.insert(assetVersions).values(values).$returningId();
    if (!created) throw new Error("Failed to insert asset version");
    const [row] = await db.select().from(assetVersions).where(eq(assetVersions.id, created.id));
    return row;
  }

  async listVersions(assetId: string) {
    return await getDb()
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.assetId, assetId))
      .orderBy(asc(assetVersions.version));
  }

  async findVersion(assetId: string, versionIdOrNumber: string | number) {
    const condition =
      typeof versionIdOrNumber === "number"
        ? and(eq(assetVersions.assetId, assetId), eq(assetVersions.version, versionIdOrNumber))
        : and(eq(assetVersions.assetId, assetId), eq(assetVersions.id, versionIdOrNumber));
    const [row] = await getDb().select().from(assetVersions).where(condition);
    return row ?? null;
  }

  async findVersionById(id: string) {
    const [row] = await getDb().select().from(assetVersions).where(eq(assetVersions.id, id));
    return row ?? null;
  }

  async updateVersion(id: string, updates: Record<string, unknown>) {
    const db = getDb();
    await db.update(assetVersions).set(updates).where(eq(assetVersions.id, id));
    const [updated] = await db.select().from(assetVersions).where(eq(assetVersions.id, id));
    return updated;
  }

  async resetApprovedVersions(assetId: string) {
    await getDb()
      .update(assetVersions)
      .set({ status: "ready" })
      .where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.status, "approved")));
  }

  async findShotAsset(shotId: string, assetId: string) {
    const [row] = await getDb()
      .select()
      .from(shotAssets)
      .where(and(eq(shotAssets.shotId, shotId), eq(shotAssets.assetId, assetId)));
    return row ?? null;
  }

  async createShotAsset(values: { shotId: string; assetId: string; assetRole: string }) {
    const db = getDb();
    const [created] = await db.insert(shotAssets).values(values).$returningId();
    if (!created) throw new Error("Failed to attach asset to shot");
    const [row] = await db.select().from(shotAssets).where(eq(shotAssets.id, created.id));
    return row;
  }

  async deleteShotAsset(shotId: string, assetId: string) {
    const result = await getDb()
      .delete(shotAssets)
      .where(and(eq(shotAssets.shotId, shotId), eq(shotAssets.assetId, assetId)));
    return result[0].affectedRows > 0;
  }

  async listShotAssets(shotId: string) {
    return await getDb()
      .select({
        id: shotAssets.id,
        shotId: shotAssets.shotId,
        assetId: shotAssets.assetId,
        assetRole: shotAssets.assetRole,
        createdAt: shotAssets.createdAt,
        asset: assets,
      })
      .from(shotAssets)
      .innerJoin(assets, eq(shotAssets.assetId, assets.id))
      .where(eq(shotAssets.shotId, shotId))
      .orderBy(asc(shotAssets.createdAt));
  }
}

export class InMemoryAssetDataStore implements AssetDataStore {
  readonly projects = new Map<string, { id: string }>();
  readonly episodes = new Map<string, { id: string; projectId: string }>();
  readonly scenes = new Map<string, { id: string; projectId: string }>();
  readonly shots = new Map<string, { id: string; projectId: string }>();
  readonly characters = new Map<string, { id: string; projectId: string }>();
  readonly locations = new Map<string, { id: string; projectId: string }>();
  readonly props = new Map<string, { id: string; projectId: string }>();
  readonly assets = new Map<string, any>();
  readonly assetVersions = new Map<string, any>();
  readonly shotAssets = new Map<string, any>();

  async findProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  async findEpisode(id: string) {
    return this.episodes.get(id) ?? null;
  }

  async findScene(id: string) {
    return this.scenes.get(id) ?? null;
  }

  async findShot(id: string) {
    return this.shots.get(id) ?? null;
  }

  async findCharacter(id: string) {
    return this.characters.get(id) ?? null;
  }

  async findLocation(id: string) {
    return this.locations.get(id) ?? null;
  }

  async findProp(id: string) {
    return this.props.get(id) ?? null;
  }

  async createAsset(values: any) {
    const id = values.id || randomUUID();
    const asset = {
      ...values,
      id,
      createdAt: new Date(),
      updatedAt: new Date(),
      approvedVersionId: values.approvedVersionId ?? null,
    };
    this.assets.set(id, asset);
    return asset;
  }

  async findAsset(id: string) {
    return this.assets.get(id) ?? null;
  }

  async findProjectAsset(projectId: string, id: string) {
    const asset = this.assets.get(id);
    if (asset && asset.projectId === projectId) {
      return asset;
    }
    return null;
  }

  async listProjectAssets(projectId: string, filters?: Record<string, string | undefined>) {
    let result = Array.from(this.assets.values()).filter((a) => a.projectId === projectId);
    if (filters?.type) result = result.filter((a) => a.type === filters.type);
    if (filters?.status) result = result.filter((a) => a.status === filters.status);
    if (filters?.episodeId) result = result.filter((a) => a.episodeId === filters.episodeId);
    if (filters?.shotId) result = result.filter((a) => a.shotId === filters.shotId);
    if (filters?.characterId) result = result.filter((a) => a.characterId === filters.characterId);
    if (filters?.locationId) result = result.filter((a) => a.locationId === filters.locationId);
    if (filters?.propId) result = result.filter((a) => a.propId === filters.propId);

    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async updateAsset(id: string, updates: Record<string, unknown>) {
    const existing = this.assets.get(id);
    if (!existing) throw new Error("Asset not found");
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.assets.set(id, updated);
    return updated;
  }

  async deleteAsset(id: string) {
    return this.assets.delete(id);
  }

  async createVersion(values: any) {
    const id = values.id || randomUUID();
    const version = {
      ...values,
      id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.assetVersions.set(id, version);
    return version;
  }

  async listVersions(assetId: string) {
    return Array.from(this.assetVersions.values())
      .filter((v) => v.assetId === assetId)
      .sort((a, b) => a.version - b.version);
  }

  async findVersion(assetId: string, versionIdOrNumber: string | number) {
    for (const version of this.assetVersions.values()) {
      if (version.assetId === assetId) {
        if (typeof versionIdOrNumber === "number" && version.version === versionIdOrNumber) {
          return version;
        }
        if (typeof versionIdOrNumber === "string" && version.id === versionIdOrNumber) {
          return version;
        }
      }
    }
    return null;
  }

  async findVersionById(id: string) {
    return this.assetVersions.get(id) ?? null;
  }

  async updateVersion(id: string, updates: Record<string, unknown>) {
    const existing = this.assetVersions.get(id);
    if (!existing) throw new Error("Asset version not found");
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.assetVersions.set(id, updated);
    return updated;
  }

  async resetApprovedVersions(assetId: string) {
    for (const [id, v] of this.assetVersions.entries()) {
      if (v.assetId === assetId && v.status === "approved") {
        this.assetVersions.set(id, { ...v, status: "ready" });
      }
    }
  }

  async findShotAsset(shotId: string, assetId: string) {
    for (const item of this.shotAssets.values()) {
      if (item.shotId === shotId && item.assetId === assetId) {
        return item;
      }
    }
    return null;
  }

  async createShotAsset(values: { shotId: string; assetId: string; assetRole: string }) {
    const id = randomUUID();
    const entry = {
      id,
      ...values,
      createdAt: new Date(),
    };
    this.shotAssets.set(id, entry);
    return entry;
  }

  async deleteShotAsset(shotId: string, assetId: string) {
    for (const [id, item] of this.shotAssets.entries()) {
      if (item.shotId === shotId && item.assetId === assetId) {
        this.shotAssets.delete(id);
        return true;
      }
    }
    return false;
  }

  async listShotAssets(shotId: string) {
    const matches = Array.from(this.shotAssets.values())
      .filter((s) => s.shotId === shotId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return matches.map((m) => ({
      ...m,
      asset: this.assets.get(m.assetId) ?? null,
    }));
  }
}
