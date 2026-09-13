import test from "node:test";
import assert from "node:assert/strict";
import { AssetService } from "../src/services/assets.js";
import { InMemoryAssetDataStore } from "../src/services/asset_store.js";

function setupService() {
  const store = new InMemoryAssetDataStore();
  const service = new AssetService(store);

  // Seed two distinct projects
  store.projects.set("proj_1", { id: "proj_1" });
  store.projects.set("proj_2", { id: "proj_2" });

  // Seed project 1 production hierarchy: episode -> scene -> shot
  store.episodes.set("ep_1", { id: "ep_1", projectId: "proj_1" });
  store.scenes.set("sc_1", { id: "sc_1", projectId: "proj_1" });
  store.shots.set("shot_1", { id: "shot_1", projectId: "proj_1" });

  // Seed project 2 production hierarchy
  store.episodes.set("ep_2", { id: "ep_2", projectId: "proj_2" });
  store.scenes.set("sc_2", { id: "sc_2", projectId: "proj_2" });
  store.shots.set("shot_2", { id: "shot_2", projectId: "proj_2" });

  // Seed creative entities
  store.characters.set("char_1", { id: "char_1", projectId: "proj_1" });
  store.characters.set("char_2", { id: "char_2", projectId: "proj_2" });
  store.locations.set("loc_1", { id: "loc_1", projectId: "proj_1" });
  store.props.set("prop_1", { id: "prop_1", projectId: "proj_1" });

  return { store, service };
}

test("Asset Lifecycle & Versioning - Scenarios 1 to 12", async (t) => {
  const { store, service } = setupService();

  // Scenario 1: media asset creation with project scope
  let asset1: any;
  await t.test("Scenario 1: media asset creation with project scope", async () => {
    asset1 = await service.createAsset("proj_1", {
      name: "Hero Character Model",
      type: "image",
      description: "Concept art portrait",
      characterId: "char_1",
    });

    assert.ok(asset1.id);
    assert.equal(asset1.projectId, "proj_1");
    assert.equal(asset1.name, "Hero Character Model");
    assert.equal(asset1.type, "image");
    assert.equal(asset1.status, "draft");
    assert.equal(asset1.approvedVersionId, null);
    assert.equal(asset1.characterId, "char_1");
  });

  // Scenario 2: asset retrieval
  await t.test("Scenario 2: asset retrieval by ID", async () => {
    const fetched = await service.getAsset(asset1.id);
    assert.ok(fetched);
    assert.equal(fetched.id, asset1.id);
    assert.equal(fetched.name, "Hero Character Model");

    const nonExistent = await service.getAsset("non-existent-id");
    assert.equal(nonExistent, null);
  });

  // Scenario 3: project-scoped asset listing
  let asset2InProj2: any;
  await t.test("Scenario 3: project-scoped asset listing", async () => {
    // Create second asset in proj_1
    await service.createAsset("proj_1", {
      name: "Background Plate",
      type: "video",
    });

    // Create asset in proj_2
    asset2InProj2 = await service.createAsset("proj_2", {
      name: "Alien Spaceship",
      type: "image",
    });

    const proj1Assets = await service.listProjectAssets("proj_1");
    assert.equal(proj1Assets.length, 2);
    assert.ok(proj1Assets.every((a) => a.projectId === "proj_1"));

    const proj2Assets = await service.listProjectAssets("proj_2");
    assert.equal(proj2Assets.length, 1);
    assert.equal(proj2Assets[0].id, asset2InProj2.id);
    assert.equal(proj2Assets[0].projectId, "proj_2");
  });

  // Scenario 4: media asset versioning (v1, v2)
  let version1: any;
  let version2: any;
  await t.test("Scenario 4: media asset versioning (v1, v2)", async () => {
    // Adding first version automatically becomes v1
    version1 = await service.createVersion(asset1.id, {
      storageKey: "projects/proj_1/assets/asset1/v1.png",
      mimeType: "image/png",
      fileSize: 102400,
      width: 1920,
      height: 1080,
    });
    assert.equal(version1.version, 1);
    assert.equal(version1.assetId, asset1.id);
    assert.equal(version1.status, "ready");

    // Asset status should have transitioned from draft to ready
    const updatedAsset = await service.getAsset(asset1.id);
    assert.equal(updatedAsset.status, "ready");

    // Adding second version automatically becomes v2
    version2 = await service.createVersion(asset1.id, {
      storageKey: "projects/proj_1/assets/asset1/v2.png",
      mimeType: "image/png",
      fileSize: 204800,
      width: 3840,
      height: 2160,
    });
    assert.equal(version2.version, 2);
    assert.equal(version2.assetId, asset1.id);
  });

  // Scenario 5: duplicate version rejection (for same asset)
  await t.test("Scenario 5: duplicate version rejection for same asset", async () => {
    await assert.rejects(
      async () => {
        await service.createVersion(asset1.id, {
          version: 1, // Already exists
          storageKey: "projects/proj_1/assets/asset1/duplicate.png",
        });
      },
      /Asset version already exists/,
    );
  });

  // Scenario 6: multiple versions preserved
  await t.test("Scenario 6: multiple versions preserved", async () => {
    const versions = await service.listVersions(asset1.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, 1);
    assert.equal(versions[0].storageKey, "projects/proj_1/assets/asset1/v1.png");
    assert.equal(versions[0].fileSize, 102400);
    assert.equal(versions[1].version, 2);
    assert.equal(versions[1].storageKey, "projects/proj_1/assets/asset1/v2.png");
    assert.equal(versions[1].fileSize, 204800);
  });

  // Scenario 7: version approval lifecycle
  await t.test("Scenario 7: version approval lifecycle", async () => {
    const approvalResult = await service.approveVersion(asset1.id, version2.id);
    assert.equal(approvalResult.version.status, "approved");
    assert.equal(approvalResult.asset.status, "approved");
    assert.equal(approvalResult.asset.approvedVersionId, version2.id);

    // Approving version 1 resets version 2 back to ready
    const approveV1 = await service.approveVersion(asset1.id, version1.id);
    assert.equal(approveV1.version.status, "approved");
    assert.equal(approveV1.asset.approvedVersionId, version1.id);

    const reloadedV2 = await service.getVersion(asset1.id, version2.id);
    assert.equal(reloadedV2.status, "ready");
  });

  // Scenario 8: version rejection lifecycle
  await t.test("Scenario 8: version rejection lifecycle", async () => {
    // Reject version 1 which is currently approved
    const rejectedV1 = await service.rejectVersion(asset1.id, version1.id);
    assert.equal(rejectedV1.status, "rejected");

    // Asset approvedVersionId should be cleared and status reset to ready
    const assetAfterReject = await service.getAsset(asset1.id);
    assert.equal(assetAfterReject.approvedVersionId, null);
    assert.equal(assetAfterReject.status, "ready");
  });

  // Scenario 9: cross-project asset access/link rejection
  await t.test("Scenario 9: cross-project asset access rejection", async () => {
    // Attempting to get asset1 (from proj_1) scoped to proj_2 returns null
    const crossProjectLookup = await service.getProjectAsset("proj_2", asset1.id);
    assert.equal(crossProjectLookup, null);

    // Creating asset in proj_1 with character from proj_2 must fail
    await assert.rejects(
      async () => {
        await service.createAsset("proj_1", {
          name: "Illegal Cross Scoped Asset",
          type: "image",
          characterId: "char_2", // Belongs to proj_2!
        });
      },
      /Character not found/,
    );
  });

  // Scenario 10: shot-to-asset attachment with required production roles
  let keyframeAsset: any;
  let videoAsset: any;
  let audioAsset: any;

  await t.test("Scenario 10: shot-to-asset attachment (reference, keyframe, video, audio)", async () => {
    // 1. Attach character/reference image (asset1 created in Scenario 1)
    const refAttachment = await service.attachAssetToShot("shot_1", asset1.id, "reference");
    assert.ok(refAttachment.id);
    assert.equal(refAttachment.shotId, "shot_1");
    assert.equal(refAttachment.assetId, asset1.id);
    assert.equal(refAttachment.assetRole, "reference");

    // 2. Create and attach keyframe image
    keyframeAsset = await service.createAsset("proj_1", {
      name: "Shot 1 Opening Keyframe",
      type: "image",
    });
    const keyframeAttachment = await service.attachAssetToShot("shot_1", keyframeAsset.id, "keyframe");
    assert.equal(keyframeAttachment.assetRole, "keyframe");

    // 3. Create and attach generated video
    videoAsset = await service.createAsset("proj_1", {
      name: "Shot 1 Take 1 Generated",
      type: "video",
    });
    const videoAttachment = await service.attachAssetToShot("shot_1", videoAsset.id, "video");
    assert.equal(videoAttachment.assetRole, "video");

    // 4. Create and attach audio asset
    audioAsset = await service.createAsset("proj_1", {
      name: "Shot 1 Dialogue Track",
      type: "audio",
    });
    const audioAttachment = await service.attachAssetToShot("shot_1", audioAsset.id, "audio");
    assert.equal(audioAttachment.assetRole, "audio");

    // Verify all 4 are listed
    const shotAssets = await service.listShotAssets("shot_1");
    assert.equal(shotAssets.length, 4);
    const roles = shotAssets.map((sa) => sa.assetRole);
    assert.deepEqual(roles.sort(), ["audio", "keyframe", "reference", "video"].sort());

    // Cannot attach same asset to shot twice
    await assert.rejects(
      async () => {
        await service.attachAssetToShot("shot_1", asset1.id, "reference");
      },
      /Asset is already attached to this shot/,
    );
  });

  // Scenario 11: shot-to-asset detachment
  await t.test("Scenario 11: shot-to-asset detachment", async () => {
    const detached = await service.detachAssetFromShot("shot_1", asset1.id);
    assert.equal(detached, true);

    const shotAssets = await service.listShotAssets("shot_1");
    assert.equal(shotAssets.length, 3);
    assert.ok(!shotAssets.some((sa) => sa.assetId === asset1.id));
  });

  // Scenario 12: cross-project shot relationship rejection
  await t.test("Scenario 12: cross-project shot relationship rejection across roles", async () => {
    // shot_1 belongs to proj_1, asset2InProj2 belongs to proj_2
    // Must be rejected with "Asset not found" across all production roles to prevent probing
    const testRoles = ["reference", "keyframe", "video", "audio"] as const;
    for (const role of testRoles) {
      await assert.rejects(
        async () => {
          await service.attachAssetToShot("shot_1", asset2InProj2.id, role);
        },
        /Asset not found/,
        `Cross-project attachment must be rejected for role "${role}"`,
      );
    }
  });
});
