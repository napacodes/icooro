import { Hono } from "hono";
import { assetService } from "../services/assets.js";
import {
  createAssetSchema,
  createAssetVersionSchema,
  formatZodError,
  updateAssetSchema,
} from "../validation/schemas.js";

type Status = 400 | 404 | 409 | 500;
const bad = (
  message: string,
  status: Status = 400,
  code = status === 404
    ? "NOT_FOUND"
    : status === 409
      ? "CONFLICT"
      : "INVALID_REQUEST",
) => ({ error: { code, message } });

const internal = () =>
  bad("An unexpected error occurred", 500, "INTERNAL_ERROR");

async function parseJsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export const assetsRoute = new Hono();
assetsRoute.onError((error) => {
  console.error("Unhandled assetsRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

export const nestedAssetsRoute = new Hono();
nestedAssetsRoute.onError((error) => {
  console.error("Unhandled nestedAssetsRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

export const assetVersionsRoute = new Hono();
assetVersionsRoute.onError((error) => {
  console.error("Unhandled assetVersionsRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

// --- Project-Scoped Assets Routes ---

nestedAssetsRoute.get("/projects/:projectId/assets", async (c) => {
  const projectId = c.req.param("projectId");
  const type = c.req.query("type");
  const status = c.req.query("status");
  const episodeId = c.req.query("episodeId");
  const shotId = c.req.query("shotId");

  try {
    const list = await assetService.listProjectAssets(projectId, {
      type,
      status,
      episodeId,
      shotId,
    });
    return c.json({ data: list });
  } catch (error) {
    console.error("Failed to list project assets", error);
    return c.json(internal(), 500);
  }
});

nestedAssetsRoute.post("/projects/:projectId/assets", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }

  const parsed = createAssetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const created = await assetService.createAsset(projectId, parsed.data);
    return c.json({ data: created }, 201);
  } catch (error: any) {
    if (
      error.message === "Project not found" ||
      error.message === "Episode not found" ||
      error.message === "Scene not found" ||
      error.message === "Shot not found" ||
      error.message === "Character not found" ||
      error.message === "Location not found" ||
      error.message === "Prop not found"
    ) {
      return c.json(bad(error.message, 404), 404);
    }
    console.error("Failed to create asset", error);
    return c.json(internal(), 500);
  }
});

nestedAssetsRoute.get("/projects/:projectId/assets/:assetId", async (c) => {
  const projectId = c.req.param("projectId");
  const assetId = c.req.param("assetId");

  try {
    const asset = await assetService.getProjectAsset(projectId, assetId);
    if (!asset) {
      return c.json(bad("Asset not found", 404), 404);
    }
    return c.json({ data: asset });
  } catch (error) {
    console.error("Failed to get project asset", error);
    return c.json(internal(), 500);
  }
});

// --- Top-Level Assets Routes ---

assetsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const asset = await assetService.getAsset(id);
    if (!asset) {
      return c.json(bad("Asset not found", 404), 404);
    }
    return c.json({ data: asset });
  } catch (error) {
    console.error("Failed to get asset", error);
    return c.json(internal(), 500);
  }
});

assetsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }

  const parsed = updateAssetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const updated = await assetService.updateAsset(id, parsed.data);
    return c.json({ data: updated });
  } catch (error: any) {
    if (
      error.message === "Asset not found" ||
      error.message === "Episode not found" ||
      error.message === "Scene not found" ||
      error.message === "Shot not found" ||
      error.message === "Character not found" ||
      error.message === "Location not found" ||
      error.message === "Prop not found"
    ) {
      return c.json(bad(error.message, 404), 404);
    }
    if (error.message.includes("Approved version does not belong")) {
      return c.json(bad(error.message, 400), 400);
    }
    console.error("Failed to update asset", error);
    return c.json(internal(), 500);
  }
});

assetsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const deleted = await assetService.deleteAsset(id);
    if (!deleted) {
      return c.json(bad("Asset not found", 404), 404);
    }
    return c.body(null, 204);
  } catch (error) {
    console.error("Failed to delete asset", error);
    return c.json(internal(), 500);
  }
});

// --- Asset Versions Sub-Routes ---

assetsRoute.get("/:id/versions", async (c) => {
  const assetId = c.req.param("id");
  try {
    const versions = await assetService.listVersions(assetId);
    return c.json({ data: versions });
  } catch (error: any) {
    if (error.message === "Asset not found") {
      return c.json(bad(error.message, 404), 404);
    }
    console.error("Failed to list asset versions", error);
    return c.json(internal(), 500);
  }
});

assetsRoute.post("/:id/versions", async (c) => {
  const assetId = c.req.param("id");
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }

  const parsed = createAssetVersionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const created = await assetService.createVersion(assetId, parsed.data);
    return c.json({ data: created }, 201);
  } catch (error: any) {
    if (error.message === "Asset not found") {
      return c.json(bad(error.message, 404), 404);
    }
    if (error.message === "Asset version already exists") {
      return c.json(bad(error.message, 409), 409);
    }
    console.error("Failed to create asset version", error);
    return c.json(internal(), 500);
  }
});

assetsRoute.get("/:id/versions/:versionId", async (c) => {
  const assetId = c.req.param("id");
  const versionId = c.req.param("versionId");

  try {
    const version = await assetService.getVersion(assetId, versionId);
    if (!version) {
      return c.json(bad("Asset version not found", 404), 404);
    }
    return c.json({ data: version });
  } catch (error) {
    console.error("Failed to get asset version", error);
    return c.json(internal(), 500);
  }
});

assetsRoute.post("/:id/versions/:versionId/approve", async (c) => {
  const assetId = c.req.param("id");
  const versionId = c.req.param("versionId");

  try {
    const result = await assetService.approveVersion(assetId, versionId);
    return c.json({ data: result });
  } catch (error: any) {
    if (error.message === "Asset version not found") {
      return c.json(bad(error.message, 404), 404);
    }
    console.error("Failed to approve asset version", error);
    return c.json(internal(), 500);
  }
});

assetsRoute.post("/:id/versions/:versionId/reject", async (c) => {
  const assetId = c.req.param("id");
  const versionId = c.req.param("versionId");

  try {
    const result = await assetService.rejectVersion(assetId, versionId);
    return c.json({ data: result });
  } catch (error: any) {
    if (error.message === "Asset version not found") {
      return c.json(bad(error.message, 404), 404);
    }
    console.error("Failed to reject asset version", error);
    return c.json(internal(), 500);
  }
});

// Top-level direct asset version retrieval
assetVersionsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const [row] = await assetService.listVersions(id).catch(() => []);
    // Try finding by id directly if not by assetId
    const version = await assetService.getVersion(id, id);
    if (!version) {
      return c.json(bad("Asset version not found", 404), 404);
    }
    return c.json({ data: version });
  } catch (error) {
    console.error("Failed to get asset version", error);
    return c.json(internal(), 500);
  }
});
