import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { episodes } from "../db/schema/episodes.js";
import { scripts } from "../db/schema/scripts.js";
import { characters } from "../db/schema/characters.js";
import { locations } from "../db/schema/locations.js";
import { props } from "../db/schema/props.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { shotCharacters } from "../db/schema/shot_characters.js";
import { shotLocations } from "../db/schema/shot_locations.js";
import { shotProps } from "../db/schema/shot_props.js";
import { shotVersions } from "../db/schema/shot_versions.js";
import { projects } from "../db/schema/projects.js";
import { assets } from "../db/schema/assets.js";

type Status = 400 | 404 | 409 | 500;
const bad = (message: string, status: Status = 400, code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INVALID_REQUEST") =>
  ({ error: { code, message }, status } as const);
const internal = () => bad("An unexpected database error occurred", 500, "INTERNAL_ERROR");
function isDuplicate(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062 || isDuplicate(candidate.cause);
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function body(c: any) {
  try {
    const value: unknown = await c.req.json();
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

function unknownField(input: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(input).find((name) => !allowed.includes(name));
}

function optionalNullableString(input: Record<string, unknown>, name: string, max?: number) {
  if (!(name in input)) return { skip: true as const };
  const value = input[name];
  if (value === null) return { value: null };
  if (typeof value !== "string") return { error: `${name} must be a string or null` };
  if (max !== undefined && value.length > max) return { error: `${name} must be ${max} characters or fewer` };
  return { value: value.trim() === "" && name !== "content" && name !== "prompt" && name !== "error" ? value.trim() || null : value };
}

function nonNegativeInteger(value: unknown, name: string) {
  if (value === null) return { value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { error: `${name} must be a non-negative integer or null` };
  }
  return { value };
}

type Config = {
  table: any;
  id: any;
  parent?: { input: string; table: any; id: any; label: string };
  order?: any[];
  fields: Record<string, { column: any; required?: boolean; nullable?: boolean; max?: number; kind: "string" | "number"; integer?: boolean; min?: number; maxValue?: number }>;
  validate?: (values: Record<string, unknown>, existing?: Record<string, unknown>) => Promise<string | null>;
};

async function parentExists(parent: Config["parent"], value: unknown) {
  if (!parent || typeof value !== "string") return false;
  const [row] = await getDb().select({ id: parent.id }).from(parent.table).where(eq(parent.id, value));
  return Boolean(row);
}

function routeFor(config: Config) {
  const route = new Hono();
  const values = (input: Record<string, unknown>, partial: boolean) => {
    const result: Record<string, unknown> = {};
    const unknown = Object.keys(input).find((name) => !(name in config.fields));
    if (unknown) return { error: `${unknown} is not a supported field` };
    for (const [name, definition] of Object.entries(config.fields)) {
      if (partial && !(name in input)) continue;
      if (!partial && !(name in input) && !definition.required) continue;
      const value = input[name];
      if (value === null && definition.nullable) {
        result[name] = null;
        continue;
      }
      if (value === undefined || (definition.required && (typeof value !== definition.kind || (definition.kind === "string" && (value as string).trim() === "")))) {
        return { error: `${name} must be a non-empty ${definition.kind}` };
      }
      if (typeof value !== definition.kind) return { error: `${name} must be a ${definition.kind}` };
      if (definition.kind === "string" && (name === "status" || definition.required) && (value as string).trim() === "") {
        return { error: `${name} must be a non-empty string` };
      }
      if (definition.kind === "string" && definition.max && (value as string).length > definition.max) {
        return { error: `${name} must be ${definition.max} characters or fewer` };
      }
      if (definition.kind === "number") {
        if (!Number.isFinite(value)) return { error: `${name} must be a finite number` };
        const integer = definition.integer || ["version", "orderIndex", "episodeNumber", "duration", "productionReady"].includes(name);
        const minimum = definition.min ?? (["version", "orderIndex", "episodeNumber"].includes(name) ? 1 : name === "duration" || name === "productionReady" ? 0 : undefined);
        if (integer && !Number.isInteger(value)) return { error: `${name} must be an integer` };
        if (minimum !== undefined && (value as number) < minimum) return { error: `${name} must be at least ${minimum}` };
        if (definition.maxValue !== undefined && (value as number) > definition.maxValue) return { error: `${name} must be at most ${definition.maxValue}` };
      }
      result[name] = definition.kind === "string" ? (value as string).trim() : value;
    }
    if (partial && Object.keys(result).length === 0) return { error: "At least one field is required" };
    return { value: result };
  };
  route.onError((error) => {
    console.error("Unhandled storytelling route error", error);
    return new Response(JSON.stringify(internal()), { status: 500, headers: { "content-type": "application/json" } });
  });
  route.get("/", async (c) => {
    try {
      const rows = await getDb().select().from(config.table).orderBy(...(config.order ?? [asc(config.id)]));
      return c.json({ data: rows });
    } catch (error) {
      console.error("Failed to list storytelling records", error);
      return c.json(internal(), 500);
    }
  });
  route.post("/", async (c) => {
    const input = await body(c);
    if (!input) return c.json(bad("Request body must be a JSON object"), 400);
    const checked = values(input, false);
    if ("error" in checked) return c.json(bad(checked.error), 400);
    try {
      if (config.parent && !(await parentExists(config.parent, input[config.parent.input]))) {
        return c.json(bad(`${config.parent.label} not found`, 404), 404);
      }
      if (config.validate) {
        const validationError = await config.validate(checked.value);
        if (validationError) return c.json(bad(validationError, 404), 404);
      }
      const [created] = await getDb().insert(config.table).values(checked.value).$returningId();
      if (!created) return c.json(internal(), 500);
      const [row] = await getDb().select().from(config.table).where(eq(config.id, created.id));
      return c.json({ data: row }, 201);
    } catch (error) {
      if (isDuplicate(error)) return c.json(bad("A record with these unique values already exists", 409), 409);
      console.error("Failed to create storytelling record", error);
      return c.json(internal(), 500);
    }
  });
  route.get("/:id", async (c) => {
    try {
      const [row] = await getDb().select().from(config.table).where(eq(config.id, c.req.param("id")));
      return row ? c.json({ data: row }) : c.json(bad("Record not found", 404), 404);
    } catch (error) { console.error(error); return c.json(internal(), 500); }
  });
  route.patch("/:id", async (c) => {
    const input = await body(c);
    if (!input) return c.json(bad("Request body must be a JSON object"), 400);
    const checked = values(input, true);
    if ("error" in checked) return c.json(bad(checked.error), 400);
    try {
      const [existing] = await getDb().select().from(config.table).where(eq(config.id, c.req.param("id")));
      if (!existing) return c.json(bad("Record not found", 404), 404);
      if (config.parent && config.parent.input in checked.value &&
        !(await parentExists(config.parent, checked.value[config.parent.input]))) {
        return c.json(bad(`${config.parent.label} not found`, 404), 404);
      }
      if (config.parent && config.parent.input in checked.value &&
        existing[config.parent.input] !== checked.value[config.parent.input]) {
        return c.json(bad(`${config.parent.label} cannot be changed after creation`, 409), 409);
      }
      if (config.validate) {
        const validationError = await config.validate(checked.value, existing);
        if (validationError) return c.json(bad(validationError, 404), 404);
      }
      await getDb().update(config.table).set(checked.value).where(eq(config.id, c.req.param("id")));
      const [row] = await getDb().select().from(config.table).where(eq(config.id, c.req.param("id")));
      return c.json({ data: row });
    } catch (error) {
      if (isDuplicate(error)) return c.json(bad("A record with these unique values already exists", 409), 409);
      console.error(error); return c.json(internal(), 500);
    }
  });
  route.delete("/:id", async (c) => {
    try {
      const result = await getDb().delete(config.table).where(eq(config.id, c.req.param("id")));
      if (result[0].affectedRows === 0) return c.json(bad("Record not found", 404), 404);
      return c.body(null, 204);
    } catch (error) { console.error(error); return c.json(internal(), 500); }
  });
  return route;
}

const projectField = { input: "projectId", table: projects, id: projects.id, label: "Project" };
async function assetBelongsToProject(assetId: unknown, projectId: unknown) {
  if (typeof assetId !== "string" || typeof projectId !== "string") return false;
  const [asset] = await getDb().select({ projectId: assets.projectId }).from(assets).where(eq(assets.id, assetId));
  return Boolean(asset && asset.projectId === projectId);
}
const projectAssetReferenceValidation = async (values: Record<string, unknown>, existing?: Record<string, unknown>) => {
  const assetId = values.referenceAssetId ?? existing?.referenceAssetId;
  if (assetId === null || assetId === undefined) return null;
  const projectId = values.projectId ?? existing?.projectId;
  return await assetBelongsToProject(assetId, projectId) ? null : "Referenced asset not found";
};
const shotVersionAssetValidation = async (values: Record<string, unknown>, existing?: Record<string, unknown>) => {
  const assetId = values.assetId ?? existing?.assetId;
  if (assetId === null || assetId === undefined) return null;
  const shotId = values.shotId ?? existing?.shotId;
  const projectId = typeof shotId === "string" ? await projectForShot(shotId) : undefined;
  return await assetBelongsToProject(assetId, projectId) ? null : "Referenced asset not found";
};
export const episodesRoute = routeFor({ table: episodes, id: episodes.id, parent: projectField, order: [asc(episodes.episodeNumber), asc(episodes.id)], fields: { projectId: { column: episodes.projectId, required: true, kind: "string" }, title: { column: episodes.title, required: true, max: 255, kind: "string" }, episodeNumber: { column: episodes.episodeNumber, required: true, kind: "number" }, status: { column: episodes.status, max: 50, kind: "string" } } });
export const scriptsRoute = routeFor({ table: scripts, id: scripts.id, parent: { input: "episodeId", table: episodes, id: episodes.id, label: "Episode" }, order: [asc(scripts.version), asc(scripts.id)], fields: { episodeId: { column: scripts.episodeId, required: true, kind: "string" }, content: { column: scripts.content, required: true, kind: "string" }, version: { column: scripts.version, required: true, kind: "number" } } });
const projectEntity = (table: any, id: any, fields: Config["fields"]) => routeFor({ table, id, parent: projectField, order: [asc(id)], fields });
export const charactersRoute = routeFor({ table: characters, id: characters.id, parent: projectField, order: [asc(characters.id)], validate: projectAssetReferenceValidation, fields: { projectId: { column: characters.projectId, required: true, kind: "string" }, name: { column: characters.name, required: true, max: 255, kind: "string" }, description: { column: characters.description, nullable: true, kind: "string" }, visualDescription: { column: characters.visualDescription, nullable: true, kind: "string" }, referenceAssetId: { column: characters.referenceAssetId, nullable: true, max: 36, kind: "string" } } });
export const locationsRoute = routeFor({ table: locations, id: locations.id, parent: projectField, order: [asc(locations.id)], validate: projectAssetReferenceValidation, fields: { projectId: { column: locations.projectId, required: true, kind: "string" }, name: { column: locations.name, required: true, max: 255, kind: "string" }, description: { column: locations.description, nullable: true, kind: "string" }, visualDescription: { column: locations.visualDescription, nullable: true, kind: "string" }, referenceAssetId: { column: locations.referenceAssetId, nullable: true, max: 36, kind: "string" } } });
export const propsRoute = routeFor({ table: props, id: props.id, parent: projectField, order: [asc(props.id)], validate: projectAssetReferenceValidation, fields: { projectId: { column: props.projectId, required: true, kind: "string" }, name: { column: props.name, required: true, max: 255, kind: "string" }, description: { column: props.description, nullable: true, kind: "string" }, visualDescription: { column: props.visualDescription, nullable: true, kind: "string" }, referenceAssetId: { column: props.referenceAssetId, nullable: true, max: 36, kind: "string" } } });
export const scenesRoute = routeFor({ table: scenes, id: scenes.id, parent: { input: "episodeId", table: episodes, id: episodes.id, label: "Episode" }, order: [asc(scenes.orderIndex), asc(scenes.id)], fields: { episodeId: { column: scenes.episodeId, required: true, kind: "string" }, name: { column: scenes.name, required: true, max: 255, kind: "string" }, description: { column: scenes.description, nullable: true, kind: "string" }, orderIndex: { column: scenes.orderIndex, required: true, kind: "number" } } });
const nullableText = (column: any, max?: number) => max === undefined
  ? { column, nullable: true, kind: "string" as const }
  : { column, nullable: true, max, kind: "string" as const };
export const shotsRoute = routeFor({ table: shots, id: shots.id, parent: { input: "sceneId", table: scenes, id: scenes.id, label: "Scene" }, order: [asc(shots.orderIndex), asc(shots.id)], fields: {
  sceneId: { column: shots.sceneId, required: true, kind: "string" }, orderIndex: { column: shots.orderIndex, required: true, kind: "number" },
  purpose: nullableText(shots.purpose, 100), shotType: nullableText(shots.shotType, 100), framing: nullableText(shots.framing, 100),
  cameraMovement: nullableText(shots.cameraMovement, 100), cameraAngle: nullableText(shots.cameraAngle, 100), prompt: nullableText(shots.prompt),
  visualDescription: nullableText(shots.visualDescription), actionDescription: nullableText(shots.actionDescription), dialogue: nullableText(shots.dialogue),
  transition: nullableText(shots.transition, 100), productionNotes: nullableText(shots.productionNotes), duration: { column: shots.duration, nullable: true, kind: "number" },
  status: { column: shots.status, max: 50, kind: "string" },
} });
export const shotVersionsRoute = routeFor({ table: shotVersions, id: shotVersions.id, parent: { input: "shotId", table: shots, id: shots.id, label: "Shot" }, order: [asc(shotVersions.version), asc(shotVersions.id)], fields: {
  shotId: { column: shotVersions.shotId, required: true, kind: "string" }, version: { column: shotVersions.version, required: true, kind: "number" }, prompt: nullableText(shotVersions.prompt),
  status: { column: shotVersions.status, max: 50, kind: "string" }, providerId: nullableText(shotVersions.providerId, 36), modelId: nullableText(shotVersions.modelId, 36),
  assetId: nullableText(shotVersions.assetId, 36), duration: { column: shotVersions.duration, nullable: true, kind: "number" }, error: nullableText(shotVersions.error),
  productionReady: { column: shotVersions.productionReady, kind: "number", integer: true, min: 0, maxValue: 1 },
}, validate: shotVersionAssetValidation });

function relationshipRoute(
  table: any,
  entityTable: any,
  entityId: any,
  fieldName: "characterId" | "locationId" | "propId",
  label: string,
  projectForEntity: (id: string) => Promise<string | undefined>,
) {
  const route = new Hono();
  route.get("/", async (c) => {
    try {
      const shotId = c.req.query("shotId");
      const rows = shotId
        ? await getDb().select().from(table).where(eq(table.shotId, shotId)).orderBy(asc(table[fieldName]), asc(table.id))
        : await getDb().select().from(table).orderBy(asc(table.shotId), asc(table[fieldName]), asc(table.id));
      return c.json({ data: rows });
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
  route.post("/", async (c) => {
    const input = await body(c);
    if (!input) return c.json(bad("Request body must be a JSON object"), 400);
    const extra = unknownField(input, ["shotId", fieldName]);
    if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
    if (typeof input.shotId !== "string" || input.shotId.trim() === "" || typeof input[fieldName] !== "string" || (input[fieldName] as string).trim() === "") {
      return c.json(bad(`shotId and ${fieldName} are required`), 400);
    }
    return createShotRelationship(c, {
      shotId: input.shotId,
      entityId: input[fieldName] as string,
      table,
      entityTable,
      entityColumn: entityId,
      fieldName,
      label,
      projectForEntity,
    });
  });
  route.delete("/:id", async (c) => {
    try {
      const result = await getDb().delete(table).where(eq(table.id, c.req.param("id")));
      return result[0].affectedRows ? c.body(null, 204) : c.json(bad("Relationship not found", 404), 404);
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
  return route;
}

async function createShotRelationship(c: any, options: {
  shotId: string;
  entityId: string;
  table: any;
  entityTable: any;
  entityColumn: any;
  fieldName: "characterId" | "locationId" | "propId";
  label: string;
  projectForEntity: (id: string) => Promise<string | undefined>;
}) {
  try {
    const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, options.shotId));
    if (!shot) return c.json(bad("Shot not found", 404), 404);
    const [entity] = await getDb().select({ id: options.entityColumn }).from(options.entityTable).where(eq(options.entityColumn, options.entityId));
    if (!entity) return c.json(bad(`${options.label} not found`, 404), 404);
    if ((await projectForShot(shot.id)) !== (await options.projectForEntity(entity.id))) {
      return c.json(bad(`${options.label} not found`, 404), 404);
    }
    const [created] = await getDb().insert(options.table).values({ shotId: shot.id, [options.fieldName]: entity.id }).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(options.table).where(eq(options.table.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad(`${options.label} relationship already exists`, 409), 409);
    console.error(error);
    return c.json(internal(), 500);
  }
}

export const shotCharactersRoute = relationshipRoute(shotCharacters, characters, characters.id, "characterId", "Character", (id) => projectForCharacter(id));
export const shotLocationsRoute = relationshipRoute(shotLocations, locations, locations.id, "locationId", "Location", (id) => projectForLocation(id));
export const shotPropsRoute = relationshipRoute(shotProps, props, props.id, "propId", "Prop", (id) => projectForProp(id));

export const nestedStorytellingRoute = new Hono();
nestedStorytellingRoute.onError((error) => {
  console.error("Unhandled nested storytelling route error", error);
  return new Response(JSON.stringify(internal()), { status: 500, headers: { "content-type": "application/json" } });
});

function registerNestedShotAsset(
  name: "characters" | "locations" | "props",
  table: any,
  entityTable: any,
  entityColumn: any,
  fieldName: "characterId" | "locationId" | "propId",
  label: string,
  projectForEntity: (id: string) => Promise<string | undefined>,
) {
  nestedStorytellingRoute.get(`/shots/:shotId/${name}`, async (c) => {
    try {
      const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, c.req.param("shotId")));
      return shot ? nestedList(c, table, table.shotId, shot.id, [asc(table[fieldName]), asc(table.id)]) : c.json(bad("Shot not found", 404), 404);
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
  nestedStorytellingRoute.post(`/shots/:shotId/${name}`, async (c) => {
    const input = await body(c);
    if (!input) return c.json(bad("Request body must be a JSON object"), 400);
    const extra = unknownField(input, [fieldName]);
    if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
    if (typeof input[fieldName] !== "string" || (input[fieldName] as string).trim() === "") {
      return c.json(bad(`${fieldName} is required`), 400);
    }
    return createShotRelationship(c, {
      shotId: c.req.param("shotId"),
      entityId: input[fieldName] as string,
      table,
      entityTable,
      entityColumn,
      fieldName,
      label,
      projectForEntity,
    });
  });
  nestedStorytellingRoute.delete(`/shots/:shotId/${name}/:entityId`, async (c) => {
    try {
      const result = await getDb().delete(table).where(and(eq(table.shotId, c.req.param("shotId")), eq(table[fieldName], c.req.param("entityId"))));
      return result[0].affectedRows ? c.body(null, 204) : c.json(bad("Relationship not found", 404), 404);
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
}

async function projectForEpisode(id: string) {
  const [episode] = await getDb().select({ projectId: episodes.projectId }).from(episodes).where(eq(episodes.id, id));
  return episode?.projectId;
}
async function projectForShot(id: string) {
  const [row] = await getDb().select({ projectId: episodes.projectId }).from(shots)
    .innerJoin(scenes, eq(shots.sceneId, scenes.id)).innerJoin(episodes, eq(scenes.episodeId, episodes.id))
    .where(eq(shots.id, id));
  return row?.projectId;
}
async function projectForCharacter(id: string) {
  const [row] = await getDb().select({ projectId: characters.projectId }).from(characters).where(eq(characters.id, id));
  return row?.projectId;
}
async function projectForLocation(id: string) {
  const [row] = await getDb().select({ projectId: locations.projectId }).from(locations).where(eq(locations.id, id));
  return row?.projectId;
}
async function projectForProp(id: string) {
  const [row] = await getDb().select({ projectId: props.projectId }).from(props).where(eq(props.id, id));
  return row?.projectId;
}
async function nestedList(c: any, table: any, column: any, value: string, order: readonly any[]) {
  const rows = await getDb().select().from(table).where(eq(column, value)).orderBy(...order);
  return c.json({ data: rows });
}

registerNestedShotAsset("characters", shotCharacters, characters, characters.id, "characterId", "Character", projectForCharacter);
registerNestedShotAsset("locations", shotLocations, locations, locations.id, "locationId", "Location", projectForLocation);
registerNestedShotAsset("props", shotProps, props, props.id, "propId", "Prop", projectForProp);

nestedStorytellingRoute.get("/projects/:projectId/episodes", async (c) => {
  try {
    const [project] = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, c.req.param("projectId")));
    return project ? nestedList(c, episodes, episodes.projectId, project.id, [asc(episodes.episodeNumber), asc(episodes.id)]) : c.json(bad("Project not found", 404), 404);
  } catch (error) {
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.post("/projects/:projectId/episodes", async (c) => {
  const input = await body(c);
  if (!input) return c.json(bad("Request body must be a JSON object"), 400);
  const extra = unknownField(input, ["title", "episodeNumber", "status"]);
  if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
  try {
    const [project] = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, c.req.param("projectId")));
    if (!project) return c.json(bad("Project not found", 404), 404);
    if (typeof input.title !== "string" || input.title.trim() === "" || input.title.length > 255 ||
      typeof input.episodeNumber !== "number" || !Number.isInteger(input.episodeNumber) || input.episodeNumber <= 0) {
      return c.json(bad("title must be a non-empty string of 255 characters or fewer and episodeNumber must be a positive integer"), 400);
    }
    if ("status" in input && (typeof input.status !== "string" || input.status.trim() === "" || input.status.length > 50)) {
      return c.json(bad("status must be a non-empty string of 50 characters or fewer"), 400);
    }
    const episodeValues: Record<string, unknown> = {
      projectId: project.id, title: input.title.trim(), episodeNumber: input.episodeNumber,
    };
    if (typeof input.status === "string" && input.status.trim()) episodeValues.status = input.status.trim();
    const [created] = await getDb().insert(episodes).values(episodeValues as any).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(episodes).where(eq(episodes.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad("Episode number already exists in this project", 409), 409);
    console.error(error);
    return c.json(internal(), 500);
  }
});

async function createCreativeEntity(c: any, name: "characters" | "locations" | "props", projectId: string, input: Record<string, unknown>) {
  const table = name === "characters" ? characters : name === "locations" ? locations : props;
  const id = name === "characters" ? characters.id : name === "locations" ? locations.id : props.id;
  const allowedFields = ["name", "description", "visualDescription", "referenceAssetId"];
  const extra = unknownField(input, allowedFields);
  if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
  if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 255) {
    return c.json(bad("name must be a non-empty string of 255 characters or fewer"), 400);
  }
  for (const field of ["description", "visualDescription"] as const) {
    if (field in input && input[field] !== null && typeof input[field] !== "string") {
      return c.json(bad(`${field} must be a string or null`), 400);
    }
  }
  if ("referenceAssetId" in input) {
    if (input.referenceAssetId !== null && typeof input.referenceAssetId !== "string") {
      return c.json(bad("referenceAssetId must be a string or null"), 400);
    }
    if (typeof input.referenceAssetId === "string" && !(await assetBelongsToProject(input.referenceAssetId, projectId))) {
      return c.json(bad("Referenced asset not found", 404), 404);
    }
  }
  try {
    const entityValues: Record<string, unknown> = { projectId, name: input.name.trim() };
    if (typeof input.description === "string" || input.description === null) entityValues.description = typeof input.description === "string" ? input.description.trim() : null;
    if (typeof input.visualDescription === "string" || input.visualDescription === null) entityValues.visualDescription = typeof input.visualDescription === "string" ? input.visualDescription.trim() : null;
    if (typeof input.referenceAssetId === "string" || input.referenceAssetId === null) {
      entityValues.referenceAssetId = input.referenceAssetId;
    }
    const [created] = await getDb().insert(table).values(entityValues as any).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(table).where(eq(id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad("A record with these unique values already exists", 409), 409);
    console.error(error);
    return c.json(internal(), 500);
  }
}

for (const [name, table, projectColumn, order] of [
  ["characters", characters, characters.projectId, [asc(characters.id)]],
  ["locations", locations, locations.projectId, [asc(locations.id)]],
  ["props", props, props.projectId, [asc(props.id)]],
] as const) {
  nestedStorytellingRoute.get(`/projects/:projectId/${name}`, async (c) => {
    try {
      const [project] = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, c.req.param("projectId")));
      return project ? nestedList(c, table, projectColumn, project.id, order) : c.json(bad("Project not found", 404), 404);
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
  nestedStorytellingRoute.post(`/projects/:projectId/${name}`, async (c) => {
    const input = await body(c);
    if (!input) return c.json(bad("Request body must be a JSON object"), 400);
    try {
      const [project] = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, c.req.param("projectId")));
      if (!project) return c.json(bad("Project not found", 404), 404);
      return createCreativeEntity(c, name, project.id, input);
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
  nestedStorytellingRoute.get(`/episodes/:episodeId/${name}`, async (c) => {
    try {
      const projectId = await projectForEpisode(c.req.param("episodeId"));
      if (!projectId) return c.json(bad("Episode not found", 404), 404);
      return nestedList(c, table, projectColumn, projectId, order);
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
  nestedStorytellingRoute.post(`/episodes/:episodeId/${name}`, async (c) => {
    const input = await body(c);
    if (!input) return c.json(bad("Request body must be a JSON object"), 400);
    try {
      const projectId = await projectForEpisode(c.req.param("episodeId"));
      if (!projectId) return c.json(bad("Episode not found", 404), 404);
      return createCreativeEntity(c, name, projectId, input);
    } catch (error) {
      console.error(error);
      return c.json(internal(), 500);
    }
  });
}

nestedStorytellingRoute.get("/episodes/:episodeId/script", async (c) => {
  try {
    const [episode] = await getDb().select({ id: episodes.id }).from(episodes).where(eq(episodes.id, c.req.param("episodeId")));
    return episode ? nestedList(c, scripts, scripts.episodeId, episode.id, [asc(scripts.version), asc(scripts.id)]) : c.json(bad("Episode not found", 404), 404);
  } catch (error) {
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.post("/episodes/:episodeId/script", async (c) => {
  const input = await body(c);
  if (!input) return c.json(bad("Request body must be a JSON object"), 400);
  const extra = unknownField(input, ["content", "version"]);
  if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
  if (typeof input.content !== "string" || input.content.trim() === "" || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version <= 0) {
    return c.json(bad("content and positive integer version are required"), 400);
  }
  try {
    const [episode] = await getDb().select({ id: episodes.id }).from(episodes).where(eq(episodes.id, c.req.param("episodeId")));
    if (!episode) return c.json(bad("Episode not found", 404), 404);
    const [created] = await getDb().insert(scripts).values({ episodeId: episode.id, content: input.content, version: input.version }).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(scripts).where(eq(scripts.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad("Script version already exists", 409), 409);
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.get("/episodes/:episodeId/scenes", async (c) => {
  try {
    const [episode] = await getDb().select({ id: episodes.id }).from(episodes).where(eq(episodes.id, c.req.param("episodeId")));
    return episode ? nestedList(c, scenes, scenes.episodeId, episode.id, [asc(scenes.orderIndex), asc(scenes.id)]) : c.json(bad("Episode not found", 404), 404);
  } catch (error) {
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.post("/episodes/:episodeId/scenes", async (c) => {
  const input = await body(c);
  if (!input) return c.json(bad("Request body must be a JSON object"), 400);
  const extra = unknownField(input, ["name", "description", "orderIndex"]);
  if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
  try {
    const [episode] = await getDb().select({ id: episodes.id }).from(episodes).where(eq(episodes.id, c.req.param("episodeId")));
    if (!episode) return c.json(bad("Episode not found", 404), 404);
    if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 255 || typeof input.orderIndex !== "number" || !Number.isInteger(input.orderIndex) || input.orderIndex <= 0) {
      return c.json(bad("name and positive integer orderIndex are required"), 400);
    }
    if ("description" in input && input.description !== null && typeof input.description !== "string") {
      return c.json(bad("description must be a string or null"), 400);
    }
    const sceneValues = { episodeId: episode.id, name: input.name.trim(), description: typeof input.description === "string" || input.description === null ? input.description : undefined, orderIndex: input.orderIndex };
    const [created] = await getDb().insert(scenes).values(sceneValues).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(scenes).where(eq(scenes.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad("A record with these unique values already exists", 409), 409);
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.post("/scenes/:sceneId/shots", async (c) => {
  const input = await body(c);
  if (!input) return c.json(bad("Request body must be a JSON object"), 400);
  const shotFields = ["orderIndex", "purpose", "shotType", "framing", "cameraMovement", "cameraAngle", "prompt", "visualDescription", "actionDescription", "dialogue", "transition", "productionNotes", "duration", "status"];
  const extra = unknownField(input, shotFields);
  if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
  try {
    const [scene] = await getDb().select({ id: scenes.id }).from(scenes).where(eq(scenes.id, c.req.param("sceneId")));
    if (!scene) return c.json(bad("Scene not found", 404), 404);
    if (typeof input.orderIndex !== "number" || !Number.isInteger(input.orderIndex) || input.orderIndex <= 0) {
      return c.json(bad("orderIndex must be a positive integer"), 400);
    }
    const limited = ["purpose", "shotType", "framing", "cameraMovement", "cameraAngle", "transition"] as const;
    for (const field of limited) {
      if (field in input) {
        const checked = optionalNullableString(input, field, 100);
        if ("error" in checked) return c.json(bad(checked.error), 400);
      }
    }
    for (const field of ["prompt", "visualDescription", "actionDescription", "dialogue", "productionNotes"] as const) {
      if (field in input && input[field] !== null && typeof input[field] !== "string") {
        return c.json(bad(`${field} must be a string or null`), 400);
      }
    }
    if ("duration" in input) {
      const checked = nonNegativeInteger(input.duration, "duration");
      if ("error" in checked) return c.json(bad(checked.error), 400);
    }
    if ("status" in input && (typeof input.status !== "string" || input.status.trim() === "" || input.status.length > 50)) {
      return c.json(bad("status must be a non-empty string of 50 characters or fewer"), 400);
    }
    const shotValues: Record<string, unknown> = { sceneId: scene.id, orderIndex: input.orderIndex };
    for (const field of ["purpose", "shotType", "framing", "cameraMovement", "cameraAngle", "prompt", "visualDescription", "actionDescription", "dialogue", "transition", "productionNotes"]) {
      if (typeof input[field] === "string" || input[field] === null) shotValues[field] = typeof input[field] === "string" ? input[field].trim() : null;
    }
    if (typeof input.duration === "number" || input.duration === null) shotValues.duration = input.duration;
    if (typeof input.status === "string" && input.status.trim()) shotValues.status = input.status.trim();
    const [created] = await getDb().insert(shots).values(shotValues as any).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(shots).where(eq(shots.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad("A record with these unique values already exists", 409), 409);
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.get("/scenes/:sceneId/shots", async (c) => {
  try {
    const [scene] = await getDb().select({ id: scenes.id }).from(scenes).where(eq(scenes.id, c.req.param("sceneId")));
    return scene ? nestedList(c, shots, shots.sceneId, scene.id, [asc(shots.orderIndex), asc(shots.id)]) : c.json(bad("Scene not found", 404), 404);
  } catch (error) {
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.get("/shots/:shotId/versions", async (c) => {
  try {
    const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, c.req.param("shotId")));
    return shot ? nestedList(c, shotVersions, shotVersions.shotId, shot.id, [asc(shotVersions.version), asc(shotVersions.id)]) : c.json(bad("Shot not found", 404), 404);
  } catch (error) {
    console.error(error);
    return c.json(internal(), 500);
  }
});
nestedStorytellingRoute.post("/shots/:shotId/versions", async (c) => {
  const input = await body(c);
  if (!input) return c.json(bad("Request body must be a JSON object"), 400);
  const extra = unknownField(input, ["version", "prompt", "status", "providerId", "modelId", "assetId", "duration", "error", "productionReady"]);
  if (extra) return c.json(bad(`${extra} is not a supported field`), 400);
  if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version <= 0) {
    return c.json(bad("version must be a positive integer"), 400);
  }
  for (const field of ["prompt", "providerId", "modelId", "assetId", "error"]) {
    if (field in input && input[field] !== null && typeof input[field] !== "string") {
      return c.json(bad(`${field} must be a string or null`), 400);
    }
  }
  if ("status" in input && (typeof input.status !== "string" || input.status.trim() === "" || input.status.length > 50)) {
    return c.json(bad("status must be a non-empty string of 50 characters or fewer"), 400);
  }
  if ("duration" in input) {
    const checked = nonNegativeInteger(input.duration, "duration");
    if ("error" in checked) return c.json(bad(checked.error), 400);
  }
  if ("productionReady" in input && input.productionReady !== 0 && input.productionReady !== 1) {
    return c.json(bad("productionReady must be 0 or 1"), 400);
  }
  try {
    const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, c.req.param("shotId")));
    if (!shot) return c.json(bad("Shot not found", 404), 404);
    if ("assetId" in input && input.assetId !== null && !(await assetBelongsToProject(input.assetId, await projectForShot(shot.id)))) {
      return c.json(bad("Referenced asset not found", 404), 404);
    }
    const versionValues: Record<string, unknown> = { shotId: shot.id, version: input.version };
    if (typeof input.prompt === "string" || input.prompt === null) versionValues.prompt = input.prompt;
    if (typeof input.status === "string" && input.status.trim()) versionValues.status = input.status.trim();
    for (const field of ["providerId", "modelId", "assetId", "error"]) {
      if (typeof input[field] === "string" || input[field] === null) versionValues[field] = input[field];
    }
    if (typeof input.duration === "number" || input.duration === null) versionValues.duration = input.duration;
    if (input.productionReady === 0 || input.productionReady === 1) versionValues.productionReady = input.productionReady;
    const [created] = await getDb().insert(shotVersions).values(versionValues as any).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(shotVersions).where(eq(shotVersions.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad("Shot version already exists", 409), 409);
    console.error("Failed to create shot version", error);
    return c.json(internal(), 500);
  }
});
