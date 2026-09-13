import test from "node:test";
import assert from "node:assert/strict";
import { locations } from "../src/db/schema/locations.js";
import { props } from "../src/db/schema/props.js";
import { characters } from "../src/db/schema/characters.js";
import { shots } from "../src/db/schema/shots.js";
import { episodes } from "../src/db/schema/episodes.js";
import { scenes } from "../src/db/schema/scenes.js";
import { projects } from "../src/db/schema/projects.js";
import { assets } from "../src/db/schema/assets.js";
import { assetVersions } from "../src/db/schema/asset_versions.js";
import { shotAssets } from "../src/db/schema/shot_assets.js";
import { aiJobs } from "../src/db/schema/ai_jobs.js";
import { getTableName } from "drizzle-orm";

test("C1-C3 Backwards Compatibility & Schema Verification", () => {
  // Verify all C1-C3 core tables exist with expected table names
  assert.equal(getTableName(projects), "projects");
  assert.equal(getTableName(episodes), "episodes");
  assert.equal(getTableName(scenes), "scenes");
  assert.equal(getTableName(shots), "shots");
  assert.equal(getTableName(characters), "characters");
  assert.equal(getTableName(locations), "locations");
  assert.equal(getTableName(props), "props");

  // Verify C4 new and extended tables
  assert.equal(getTableName(assets), "assets");
  assert.equal(getTableName(assetVersions), "asset_versions");
  assert.equal(getTableName(shotAssets), "shot_assets");
  assert.equal(getTableName(aiJobs), "ai_jobs");

  // Verify locations has referenceAssetId
  assert.ok(locations.referenceAssetId, "locations table must have referenceAssetId");

  // Verify props has referenceAssetId
  assert.ok(props.referenceAssetId, "props table must have referenceAssetId");

  // Verify aiJobs has C4 extended fields
  assert.ok(aiJobs.assetVersionId, "aiJobs table must have assetVersionId");
  assert.ok(aiJobs.prompt, "aiJobs table must have prompt");
  assert.ok(aiJobs.targetMediaType, "aiJobs table must have targetMediaType");
  assert.ok(aiJobs.progress, "aiJobs table must have progress");

  // Verify assets has C4 extended fields
  assert.ok(assets.approvedVersionId, "assets table must have approvedVersionId");
  assert.ok(assets.characterId, "assets table must have characterId");
  assert.ok(assets.locationId, "assets table must have locationId");
  assert.ok(assets.propId, "assets table must have propId");

  // Verify assets approvedVersionId has foreign key constraint to asset_versions
  const assetFks = (assets as any)[Symbol.for("drizzle:MySqlInlineForeignKeys")] || [];
  const approvedVersionFk = assetFks.find((fk: any) =>
    fk.reference().columns.some((c: any) => c.name === "approved_version_id"),
  );
  assert.ok(approvedVersionFk, "assets.approved_version_id must have foreign key constraint");
  assert.equal(approvedVersionFk.onDelete, "set null");
  assert.equal(
    approvedVersionFk.reference().foreignTable[Symbol.for("drizzle:Name")],
    "asset_versions",
  );
});
