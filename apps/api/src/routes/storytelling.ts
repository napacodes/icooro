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
import { shotVersions } from "../db/schema/shot_versions.js";
import { projects } from "../db/schema/projects.js";

type Status = 400 | 404 | 409 | 500;
const bad = (message: string, status: Status = 400, code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INVALID_REQUEST") =>
  ({ error: { code, message }, status } as const);
const internal = () => bad("An unexpected database error occurred", 500, "INTERNAL_ERROR");
function isDuplicate(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || isDuplicate(candidate.cause);
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

type Config = {
  table: any;
  id: any;
  parent?: { input: string; table: any; id: any; label: string };
  order?: any[];
  fields: Record<string, { column: any; required?: boolean; nullable?: boolean; max?: number; kind: "string" | "number" }>;
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
      if (definition.kind === "string" && definition.max && (value as string).length > definition.max) {
        return { error: `${name} must be ${definition.max} characters or fewer` };
      }
      if (definition.kind === "number" && (!Number.isFinite(value) || (value as number) < 0) && name === "duration") {
        return { error: `${name} must be a non-negative number` };
      }
      if (definition.kind === "number" && (!Number.isInteger(value) || (value as number) <= 0) &&
        (name === "version" || name === "orderIndex" || name === "episodeNumber")) {
        return { error: `${name} must be a positive integer` };
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
  const exists = async (id: string) => {
    const [row] = await getDb().select({ id: config.id }).from(config.table).where(eq(config.id, id));
    return Boolean(row);
  };
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
export const episodesRoute = routeFor({ table: episodes, id: episodes.id, parent: projectField, order: [asc(episodes.episodeNumber), asc(episodes.id)], fields: { projectId: { column: episodes.projectId, required: true, kind: "string" }, title: { column: episodes.title, required: true, max: 255, kind: "string" }, episodeNumber: { column: episodes.episodeNumber, required: true, kind: "number" }, status: { column: episodes.status, max: 50, kind: "string" } } });
export const scriptsRoute = routeFor({ table: scripts, id: scripts.id, parent: { input: "episodeId", table: episodes, id: episodes.id, label: "Episode" }, order: [asc(scripts.version), asc(scripts.id)], fields: { episodeId: { column: scripts.episodeId, required: true, kind: "string" }, content: { column: scripts.content, required: true, kind: "string" }, version: { column: scripts.version, required: true, kind: "number" } } });
const projectEntity = (table: any, id: any, fields: Config["fields"]) => routeFor({ table, id, parent: projectField, order: [asc(id)], fields });
export const charactersRoute = projectEntity(characters, characters.id, { projectId: { column: characters.projectId, required: true, kind: "string" }, name: { column: characters.name, required: true, max: 255, kind: "string" }, description: { column: characters.description, nullable: true, kind: "string" }, visualDescription: { column: characters.visualDescription, nullable: true, kind: "string" }, referenceAssetId: { column: characters.referenceAssetId, nullable: true, kind: "string" } });
export const locationsRoute = projectEntity(locations, locations.id, { projectId: { column: locations.projectId, required: true, kind: "string" }, name: { column: locations.name, required: true, max: 255, kind: "string" }, description: { column: locations.description, nullable: true, kind: "string" }, visualDescription: { column: locations.visualDescription, nullable: true, kind: "string" } });
export const propsRoute = projectEntity(props, props.id, { projectId: { column: props.projectId, required: true, kind: "string" }, name: { column: props.name, required: true, max: 255, kind: "string" }, description: { column: props.description, nullable: true, kind: "string" }, visualDescription: { column: props.visualDescription, nullable: true, kind: "string" } });
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
  status: { column: shotVersions.status, max: 50, kind: "string" }, providerId: nullableText(shotVersions.providerId), modelId: nullableText(shotVersions.modelId),
  assetId: nullableText(shotVersions.assetId), duration: { column: shotVersions.duration, nullable: true, kind: "number" }, error: nullableText(shotVersions.error),
  productionReady: { column: shotVersions.productionReady, kind: "number" },
} });

export const shotCharactersRoute = new Hono();
shotCharactersRoute.get("/", async (c) => {
  try { const rows = await getDb().select().from(shotCharacters).orderBy(asc(shotCharacters.shotId), asc(shotCharacters.characterId)); return c.json({ data: rows }); }
  catch (error) { console.error(error); return c.json(internal(), 500); }
});
shotCharactersRoute.post("/", async (c) => {
  const input = await body(c);
  if (!input || typeof input.shotId !== "string" || typeof input.characterId !== "string") return c.json(bad("shotId and characterId are required"), 400);
  try {
    const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, input.shotId));
    const [character] = await getDb().select({ id: characters.id }).from(characters).where(eq(characters.id, input.characterId));
    if (!shot || !character) return c.json(bad("Shot or character not found", 404), 404);
    if ((await projectForShot(shot.id)) !== (await projectForCharacter(character.id))) return c.json(bad("Shot and character must belong to the same project", 404), 404);
    const [created] = await getDb().insert(shotCharacters).values({ shotId: input.shotId, characterId: input.characterId }).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(shotCharacters).where(eq(shotCharacters.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isDuplicate(error)) return c.json(bad("Shot-character relationship already exists", 409), 409);
    console.error(error); return c.json(internal(), 500);
  }
});
shotCharactersRoute.delete("/:id", async (c) => {
  try { const result = await getDb().delete(shotCharacters).where(eq(shotCharacters.id, c.req.param("id"))); if (result[0].affectedRows === 0) return c.json(bad("Relationship not found", 404), 404); return c.body(null, 204); }
  catch (error) { console.error(error); return c.json(internal(), 500); }
});

// Nested storytelling contracts. These handlers intentionally resolve ownership
// through the parent record rather than trusting a client-supplied project id.
export const nestedStorytellingRoute = new Hono();
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
async function nestedList(c: any, table: any, column: any, value: string, order: readonly any[]) {
  const rows = await getDb().select().from(table).where(eq(column, value)).orderBy(...order);
  return c.json({ data: rows });
}

nestedStorytellingRoute.get("/projects/:projectId/episodes", async (c) => {
  const [project] = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, c.req.param("projectId")));
  return project ? nestedList(c, episodes, episodes.projectId, project.id, [asc(episodes.episodeNumber), asc(episodes.id)]) : c.json(bad("Project not found", 404), 404);
});
nestedStorytellingRoute.post("/projects/:projectId/episodes", async (c) => {
  const input = await body(c);
  if (!input) return c.json(bad("Request body must be a JSON object"), 400);
  const [project] = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, c.req.param("projectId")));
  if (!project) return c.json(bad("Project not found", 404), 404);
  if (typeof input.title !== "string" || input.title.trim() === "" || input.title.length > 255 ||
    typeof input.episodeNumber !== "number" || !Number.isInteger(input.episodeNumber) || input.episodeNumber <= 0) {
    return c.json(bad("title must be a non-empty string of 255 characters or fewer and episodeNumber must be a positive integer"), 400);
  }
  if ("status" in input && (typeof input.status !== "string" || input.status.trim() === "" || input.status.length > 50)) {
    return c.json(bad("status must be a non-empty string of 50 characters or fewer"), 400);
  }
  try {
    const episodeValues: Record<string, unknown> = {
      projectId: c.req.param("projectId"), title: input.title.trim(), episodeNumber: input.episodeNumber,
    };
    if (typeof input.status === "string" && input.status.trim()) episodeValues.status = input.status.trim();
    const [created] = await getDb().insert(episodes).values(episodeValues as any).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(episodes).where(eq(episodes.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) { if (isDuplicate(error)) return c.json(bad("Episode number already exists in this project", 409), 409); return c.json(internal(), 500); }
});
nestedStorytellingRoute.get("/episodes/:episodeId/script", async (c) => nestedList(c, scripts, scripts.episodeId, c.req.param("episodeId"), [asc(scripts.version), asc(scripts.id)]));
nestedStorytellingRoute.post("/episodes/:episodeId/script", async (c) => {
  const input = await body(c);
  if (!input || typeof input.content !== "string" || input.content.trim() === "" || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version <= 0) return c.json(bad("content and positive integer version are required"), 400);
  const [episode] = await getDb().select({ id: episodes.id }).from(episodes).where(eq(episodes.id, c.req.param("episodeId")));
  if (!episode) return c.json(bad("Episode not found", 404), 404);
  try {
    const [created] = await getDb().insert(scripts).values({ episodeId: episode.id, content: input.content, version: input.version }).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(scripts).where(eq(scripts.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) { if (isDuplicate(error)) return c.json(bad("Script version already exists", 409), 409); return c.json(internal(), 500); }
});

for (const [name, table, projectColumn, id, order] of [
  ["characters", characters, characters.projectId, characters.id, [asc(characters.id)]],
  ["locations", locations, locations.projectId, locations.id, [asc(locations.id)]],
  ["props", props, props.projectId, props.id, [asc(props.id)]],
] as const) {
  nestedStorytellingRoute.get(`/episodes/:episodeId/${name}`, async (c) => {
    const projectId = await projectForEpisode(c.req.param("episodeId"));
    if (!projectId) return c.json(bad("Episode not found", 404), 404);
    return nestedList(c, table, projectColumn, projectId, order);
  });
  nestedStorytellingRoute.post(`/episodes/:episodeId/${name}`, async (c) => {
    const projectId = await projectForEpisode(c.req.param("episodeId"));
    const input = await body(c);
    if (!projectId) return c.json(bad("Episode not found", 404), 404);
    if (!input || typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 255) return c.json(bad("name must be a non-empty string of 255 characters or fewer"), 400);
    try {
      const entityValues: Record<string, unknown> = { projectId, name: input.name.trim() };
      if (typeof input.description === "string" || input.description === null) entityValues.description = input.description;
      if (typeof input.visualDescription === "string" || input.visualDescription === null) entityValues.visualDescription = input.visualDescription;
      const [created] = await getDb().insert(table).values(entityValues as any).$returningId();
      if (!created) return c.json(internal(), 500);
      const [row] = await getDb().select().from(table).where(eq(id, created.id));
      return c.json({ data: row }, 201);
    } catch { return c.json(internal(), 500); }
  });
}
nestedStorytellingRoute.get("/episodes/:episodeId/scenes", async (c) => {
  const [episode] = await getDb().select({ id: episodes.id }).from(episodes).where(eq(episodes.id, c.req.param("episodeId")));
  return episode ? nestedList(c, scenes, scenes.episodeId, episode.id, [asc(scenes.orderIndex), asc(scenes.id)]) : c.json(bad("Episode not found", 404), 404);
});
nestedStorytellingRoute.post("/episodes/:episodeId/scenes", async (c) => {
  const input = await body(c);
  const [episode] = await getDb().select({ id: episodes.id }).from(episodes).where(eq(episodes.id, c.req.param("episodeId")));
  if (!episode) return c.json(bad("Episode not found", 404), 404);
  if (!input || typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 255 || typeof input.orderIndex !== "number" || !Number.isInteger(input.orderIndex) || input.orderIndex <= 0) return c.json(bad("name and positive integer orderIndex are required"), 400);
  if (Object.keys(input).some((field) => !["name", "description", "orderIndex"].includes(field))) return c.json(bad("Unsupported scene field"), 400);
  if ("description" in input && input.description !== null && typeof input.description !== "string") return c.json(bad("description must be a string or null"), 400);
  try {
    const sceneValues = { episodeId: episode.id, name: input.name.trim(), description: typeof input.description === "string" || input.description === null ? input.description : undefined, orderIndex: input.orderIndex };
    const [created] = await getDb().insert(scenes).values(sceneValues).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(scenes).where(eq(scenes.id, created.id));
    return c.json({ data: row }, 201);
  } catch { return c.json(internal(), 500); }
});
nestedStorytellingRoute.post("/scenes/:sceneId/shots", async (c) => {
  const input = await body(c);
  const [scene] = await getDb().select({ id: scenes.id }).from(scenes).where(eq(scenes.id, c.req.param("sceneId")));
  if (!scene) return c.json(bad("Scene not found", 404), 404);
  if (!input || typeof input.orderIndex !== "number" || !Number.isInteger(input.orderIndex) || input.orderIndex <= 0) return c.json(bad("orderIndex must be a positive integer"), 400);
  if ("prompt" in input && input.prompt !== null && typeof input.prompt !== "string") return c.json(bad("prompt must be a string or null"), 400);
  if ("duration" in input && input.duration !== null && (typeof input.duration !== "number" || !Number.isFinite(input.duration) || input.duration < 0)) return c.json(bad("duration must be a non-negative number or null"), 400);
  if ("status" in input && (typeof input.status !== "string" || input.status.trim() === "")) return c.json(bad("status must be a non-empty string"), 400);
  const shotFields = ["orderIndex", "purpose", "shotType", "framing", "cameraMovement", "cameraAngle", "prompt", "visualDescription", "actionDescription", "dialogue", "transition", "productionNotes", "duration", "status"];
  if (Object.keys(input).some((field) => !shotFields.includes(field))) return c.json(bad("Unsupported shot field"), 400);
  try {
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
  } catch { return c.json(internal(), 500); }
});
nestedStorytellingRoute.get("/scenes/:sceneId/shots", async (c) => {
  const [scene] = await getDb().select({ id: scenes.id }).from(scenes).where(eq(scenes.id, c.req.param("sceneId")));
  return scene ? nestedList(c, shots, shots.sceneId, scene.id, [asc(shots.orderIndex), asc(shots.id)]) : c.json(bad("Scene not found", 404), 404);
});
nestedStorytellingRoute.get("/shots/:shotId/characters", async (c) => {
  const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, c.req.param("shotId")));
  return shot ? nestedList(c, shotCharacters, shotCharacters.shotId, shot.id, [asc(shotCharacters.characterId)]) : c.json(bad("Shot not found", 404), 404);
});
nestedStorytellingRoute.post("/shots/:shotId/characters", async (c) => {
  const input = await body(c);
  if (!input || typeof input.characterId !== "string") return c.json(bad("characterId is required"), 400);
  try {
    const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, c.req.param("shotId")));
    const [character] = await getDb().select({ id: characters.id }).from(characters).where(eq(characters.id, input.characterId));
    if (!shot || !character) return c.json(bad("Shot or character not found", 404), 404);
    if ((await projectForShot(shot.id)) !== (await projectForCharacter(character.id))) return c.json(bad("Shot and character must belong to the same project", 404), 404);
    const [created] = await getDb().insert(shotCharacters).values({ shotId: shot.id, characterId: character.id }).$returningId();
    if (!created) return c.json(internal(), 500);
    const [row] = await getDb().select().from(shotCharacters).where(eq(shotCharacters.id, created.id));
    return c.json({ data: row }, 201);
  } catch (error) { if (isDuplicate(error)) return c.json(bad("Shot-character relationship already exists", 409), 409); return c.json(internal(), 500); }
});
nestedStorytellingRoute.delete("/shots/:shotId/characters/:characterId", async (c) => {
  const result = await getDb().delete(shotCharacters).where(and(eq(shotCharacters.shotId, c.req.param("shotId")), eq(shotCharacters.characterId, c.req.param("characterId"))));
  return result[0].affectedRows ? c.body(null, 204) : c.json(bad("Relationship not found", 404), 404);
});
nestedStorytellingRoute.get("/shots/:shotId/versions", async (c) => {
  const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, c.req.param("shotId")));
  return shot ? nestedList(c, shotVersions, shotVersions.shotId, shot.id, [asc(shotVersions.version), asc(shotVersions.id)]) : c.json(bad("Shot not found", 404), 404);
});
nestedStorytellingRoute.post("/shots/:shotId/versions", async (c) => {
  const input = await body(c);
  if (!input || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version <= 0) return c.json(bad("version must be a positive integer"), 400);
  for (const field of ["prompt", "providerId", "modelId", "assetId", "error"]) {
    if (field in input && input[field] !== null && typeof input[field] !== "string") return c.json(bad(`${field} must be a string or null`), 400);
  }
  if ("status" in input && (typeof input.status !== "string" || input.status.trim() === "")) return c.json(bad("status must be a non-empty string"), 400);
  if ("duration" in input && input.duration !== null && (typeof input.duration !== "number" || !Number.isFinite(input.duration) || input.duration < 0)) return c.json(bad("duration must be a non-negative number or null"), 400);
  if ("productionReady" in input && (input.productionReady !== 0 && input.productionReady !== 1)) return c.json(bad("productionReady must be 0 or 1"), 400);
  const [shot] = await getDb().select({ id: shots.id }).from(shots).where(eq(shots.id, c.req.param("shotId")));
  if (!shot) return c.json(bad("Shot not found", 404), 404);
  try {
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
  } catch (error) { if (isDuplicate(error)) return c.json(bad("Shot version already exists", 409), 409); console.error("Failed to create shot version", error); return c.json(internal(), 500); }
});
