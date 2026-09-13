import test from "node:test";
import assert from "node:assert/strict";
import {
  createAssetSchema,
  updateAssetSchema,
  createAssetVersionSchema,
  attachShotAssetSchema,
  createGenerationJobSchema,
  formatZodError,
} from "../src/validation/schemas.js";

test("Validation Schemas - Scenario 17: invalid media type rejection and field validation", () => {
  // 1. Valid asset creations
  const validImage = createAssetSchema.safeParse({
    name: "Hero Portrait",
    type: "image",
    description: "Close up of protagonist",
  });
  assert.equal(validImage.success, true);
  if (validImage.success) {
    assert.equal(validImage.data.status, "draft"); // Default status
  }

  const validVideo = createAssetSchema.safeParse({
    name: "Opening Scene Plate",
    type: "video",
  });
  assert.equal(validVideo.success, true);

  const validAudio = createAssetSchema.safeParse({
    name: "Foley footsteps",
    type: "audio",
  });
  assert.equal(validAudio.success, true);

  // 2. Invalid media types must be strictly rejected (including 3D models)
  const invalidTypes = [
    "pdf",
    "executable",
    "unknown",
    "zip",
    "text",
    "binary",
    "model_3d",
    "3d_model",
    "3d",
    "",
    123,
    null,
  ];
  for (const badType of invalidTypes) {
    const res = createAssetSchema.safeParse({
      name: "Bad Asset",
      type: badType,
    });
    assert.equal(res.success, false, `Media type "${badType}" must be rejected`);
  }

  // 3. Asset creation missing name must be rejected
  const missingName = createAssetSchema.safeParse({
    type: "image",
  });
  assert.equal(missingName.success, false);

  // 4. Asset version validation
  const validVersion = createAssetVersionSchema.safeParse({
    storageKey: "projects/p1/assets/v1.png",
    version: 1,
    mimeType: "image/png",
    width: 1920,
    height: 1080,
  });
  assert.equal(validVersion.success, true);

  // Negative or zero version must be rejected
  const zeroVersion = createAssetVersionSchema.safeParse({
    storageKey: "projects/p1/assets/v0.png",
    version: 0,
  });
  assert.equal(zeroVersion.success, false);

  const negativeVersion = createAssetVersionSchema.safeParse({
    storageKey: "projects/p1/assets/v-1.png",
    version: -1,
  });
  assert.equal(negativeVersion.success, false);

  // Missing storageKey must be rejected
  const missingStorageKey = createAssetVersionSchema.safeParse({
    version: 1,
  });
  assert.equal(missingStorageKey.success, false);

  // 5. Shot asset attachment validation: all 7 required production roles
  const validRoles = [
    "reference",
    "keyframe",
    "video",
    "audio",
    "background",
    "plate",
    "vfx_element",
  ] as const;

  for (const role of validRoles) {
    const validAttachment = attachShotAssetSchema.safeParse({
      assetId: "12345678-1234-1234-1234-123456789abc",
      assetRole: role,
    });
    assert.equal(validAttachment.success, true, `Role "${role}" must be accepted`);
  }

  // Default role is "reference"
  const defaultRoleAttachment = attachShotAssetSchema.safeParse({
    assetId: "12345678-1234-1234-1234-123456789abc",
  });
  assert.equal(defaultRoleAttachment.success, true);
  if (defaultRoleAttachment.success) {
    assert.equal(defaultRoleAttachment.data.assetRole, "reference");
  }

  // Invalid roles must be rejected
  const invalidRoles = ["actor", "model_3d", "invalid_role", "subtitles", "music_track"];
  for (const badRole of invalidRoles) {
    const invalidAttachment = attachShotAssetSchema.safeParse({
      assetId: "12345678-1234-1234-1234-123456789abc",
      assetRole: badRole,
    });
    assert.equal(invalidAttachment.success, false, `Role "${badRole}" must be rejected`);
  }

  // Invalid assetId length
  const invalidAssetId = attachShotAssetSchema.safeParse({
    assetId: "too-short",
  });
  assert.equal(invalidAssetId.success, false);

  // 6. formatZodError formatting
  if (!missingName.success) {
    const formatted = formatZodError(missingName.error);
    assert.equal(formatted.error.code, "INVALID_REQUEST");
    assert.ok(formatted.error.message.length > 0);
  }
});
