import { Hono } from "hono";
import { assetService } from "../services/assets.js";
import { attachShotAssetSchema, formatZodError } from "../validation/schemas.js";

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

export const shotAssetsRoute = new Hono();
shotAssetsRoute.onError((error) => {
  console.error("Unhandled shotAssetsRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

export const nestedShotAssetsRoute = new Hono();
nestedShotAssetsRoute.onError((error) => {
  console.error("Unhandled nestedShotAssetsRoute error", error);
  return new Response(JSON.stringify(internal()), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

nestedShotAssetsRoute.get("/shots/:shotId/assets", async (c) => {
  const shotId = c.req.param("shotId");
  try {
    const list = await assetService.listShotAssets(shotId);
    return c.json({ data: list });
  } catch (error: any) {
    if (error.message === "Shot not found") {
      return c.json(bad(error.message, 404), 404);
    }
    console.error("Failed to list shot assets", error);
    return c.json(internal(), 500);
  }
});

nestedShotAssetsRoute.post("/shots/:shotId/assets", async (c) => {
  const shotId = c.req.param("shotId");
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }

  const parsed = attachShotAssetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const attached = await assetService.attachAssetToShot(
      shotId,
      parsed.data.assetId,
      parsed.data.assetRole,
    );
    return c.json({ data: attached }, 201);
  } catch (error: any) {
    if (error.message === "Shot not found" || error.message === "Asset not found") {
      return c.json(bad(error.message, 404), 404);
    }
    if (error.message === "Asset is already attached to this shot") {
      return c.json(bad(error.message, 409), 409);
    }
    console.error("Failed to attach shot asset", error);
    return c.json(internal(), 500);
  }
});

nestedShotAssetsRoute.delete("/shots/:shotId/assets/:assetId", async (c) => {
  const shotId = c.req.param("shotId");
  const assetId = c.req.param("assetId");

  try {
    const removed = await assetService.detachAssetFromShot(shotId, assetId);
    if (!removed) {
      return c.json(bad("Relationship not found", 404), 404);
    }
    return c.body(null, 204);
  } catch (error) {
    console.error("Failed to detach shot asset", error);
    return c.json(internal(), 500);
  }
});
