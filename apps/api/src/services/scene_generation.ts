import { and, eq } from "drizzle-orm";
import {
  sceneListContractSchema,
  scriptContractSchema,
  storyContractSchema,
  type SceneListContract,
  type ScriptContract,
  type StoryContract,
} from "@icooro/shared";
import {
  findAdaptersForCapability,
  type AdapterCandidate,
  type DbLike,
} from "../providers/capabilities.js";
import { ProviderError, type TextProvider } from "../providers/types.js";
import { productionPlanService } from "./production_plan.js";
import { buildScenePrompt } from "./scene_prompt.js";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import { episodes } from "../db/schema/episodes.js";
import { scripts } from "../db/schema/scripts.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { productionPlans } from "../db/schema/production_plans.js";

/**
 * Scene generation (C7.4): the third AI-assisted Production Director step.
 *
 * ProductionPlan → validated Story + Script → Scene Generator (generic text
 * provider) → structured scene list → rows in the EXISTING `scenes` table
 *
 * Orchestration, not duplication: the generator writes into the EXISTING C2/C3
 * domain. Generated scenes become ordinary rows in the episode's `scenes`
 * table — no parallel scene model, no SceneVersion, no migration. The plan
 * records only the reference (`plan.sceneIds`: the ids of the generated set).
 *
 * Integration rules (same as C7.2/C7.3):
 * - The service depends ONLY on the C6.7/C6.8 provider abstraction
 *   (`findAdaptersForCapability` routing + the generic `TextProvider`
 *   interface). It never names a specific provider (OpenAI/Gemini/ChatFire)
 *   and performs no provider-specific request or response handling.
 * - Generation is planning-time and synchronous: no media GenerationJob, no
 *   background worker, no invented text job type.
 * - A story AND a script are REQUIRED: generation without either is a
 *   validation error, never a silent invention.
 * - Every safety check (story, script, episode relationship, shot
 *   preservation) runs BEFORE any destructive change or provider call, so a
 *   failed generation writes nothing and a blocked regeneration preserves
 *   every existing scene and shot.
 */

/** The only plan status from which scene generation may run (planning-time AI). */
const GENERATION_ALLOWED_STATUS = "planning";

export class SceneGenerationError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(message: string, status: 400 | 404 | 409 | 502 = 502) {
    super(message);
    this.name = "SceneGenerationError";
    this.status = status;
  }
}

/**
 * Extract the first JSON object from model text (tolerating fences and stray
 * prose). Same parsing contract as C7.2's and C7.3's generators.
 */
export function extractSceneJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }

  throw new SceneGenerationError(
    "The AI response did not contain a valid JSON object.",
    502,
  );
}

/**
 * Parse and validate raw model output against the shared scene-list
 * contract. The validated (unknown-key-stripped) object is the only thing
 * that ever reaches the `scenes` table.
 */
export function parseSceneResponse(rawText: string): SceneListContract {
  const parsed = extractSceneJsonObject(rawText);
  const result = sceneListContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new SceneGenerationError(
      "The AI response did not match the required scene structure.",
      502,
    );
  }
  return result.data;
}

export interface SceneGenerationInput {
  projectId: string;
  productionPlanId: string;
}

export interface SceneGenerationResult {
  /** The episode the scenes were written to. */
  episode: { id: string; projectId: string; title: string; episodeNumber: number; status: string };
  /** The newly generated scene rows (in narrative order). */
  scenes: Array<{
    id: string;
    episodeId: string;
    name: string;
    description: string;
    orderIndex: number;
  }>;
  /** The script version the scene list was derived from. */
  scriptVersion: { id: string; version: number };
  /** The updated plan payload (`sceneIds` merged, all other keys preserved). */
  plan: Record<string, unknown>;
}

/**
 * Deterministic model choice — identical rule to C7.2/C7.3's generators
 * (earliest createdAt wins, mirroring C6.8.2 job routing).
 */
function compareByCreatedAt(a: AdapterCandidate, b: AdapterCandidate): number {
  return createdAtTime(a.model.createdAt) - createdAtTime(b.model.createdAt);
}

function createdAtTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.POSITIVE_INFINITY;
}

/** True when `value` is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class SceneGenerationService {
  /**
   * Generates (or regenerates) a structured scene list from the plan's story
   * and script and persists it as rows in the episode's existing `scenes`
   * table. Planning-time only: allowed solely while the plan is in
   * `planning` status. Ownership is enforced by the caller: the route checks
   * project ownership C7.1-style, and every lookup below is scoped to the
   * project.
   */
  async generateSceneList(input: SceneGenerationInput): Promise<SceneGenerationResult> {
    const db: DbLike = getDb();

    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const existing = await productionPlanService.getPlan(
      input.productionPlanId,
      input.projectId,
    );
    if (!existing) {
      throw new SceneGenerationError("Production plan not found", 404);
    }

    // 2. State gate: scene generation is planning-time only.
    if (existing.status !== GENERATION_ALLOWED_STATUS) {
      throw new SceneGenerationError(
        `Scenes can only be generated while the production plan is in "${GENERATION_ALLOWED_STATUS}" status (current status: "${existing.status}")`,
        409,
      );
    }

    // 3. Story REQUIRED: re-validated from the payload (user-editable), never
    //    silently invented.
    const story = this.extractStoryFromPlan(existing.plan);
    if (!story) {
      throw new SceneGenerationError(
        "No story has been generated for this production plan yet. Generate a story first (C7.2) before generating scenes.",
        400,
      );
    }

    // 4. Episode relationship precondition: same precedence as C7.3 — the
    //    plan row's episodeId, then the payload's episodeId — verified to
    //    exist within the project BEFORE any provider work, so a wrong
    //    project/episode/plan relationship fails fast as a 404 with zero
    //    side effects. Unlike C7.3 there is NO episode-creation fallback:
    //    the script prerequisite implies an episode already exists.
    const episode = await this.findReferencedEpisode(db, input.projectId, existing);

    // 5. Script REQUIRED: resolve + revalidate BEFORE any provider call.
    //    An explicitly referenced but missing/cross-episode script is a 404;
    //    an invalid one is a 400; neither silently falls back to another
    //    version. With no reference, the highest version on the episode is
    //    used. A missing or invalid script here is a 400 and nothing runs.
    const script = await this.resolveScript(db, episode.id, existing.plan);

    // 6. Regeneration safety: resolved BEFORE any destructive change or
    //    provider call, so a blocked regeneration preserves every existing
    //    scene and shot untouched, and a failing generation never runs.
    const previousSceneIds = this.extractSceneIdsFromPlan(existing.plan);
    const replaceable =
      previousSceneIds.length > 0
        ? await this.resolveReplaceableScenes(db, episode.id, previousSceneIds)
        : [];

    // 7. Prompt construction (dedicated builder; request + story + script +
    //    context). All persistence still happens strictly after output
    //    validation, so every failure path so far has written nothing.
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const projectName = typeof project?.name === "string" ? project.name : null;
    const builtPrompt = buildScenePrompt({
      plan: {
        request: existing.request,
        targetDurationSeconds: existing.targetDurationSeconds,
        preferences: existing.preferences,
      },
      story,
      script,
      projectName,
    });

    // 8. Model selection through the existing C6.8 capability routing —
    //    capability "text", adapter-constructible candidates only. No
    //    provider type is named anywhere in this service.
    const candidates = await findAdaptersForCapability({ db, capability: "text" });
    if (candidates.length === 0) {
      throw new SceneGenerationError(
        "No enabled text model is configured for scene generation.",
        400,
      );
    }
    const chosen = [...candidates].sort(compareByCreatedAt)[0];
    if (!chosen) {
      throw new SceneGenerationError(
        "No enabled text model is configured for scene generation.",
        400,
      );
    }

    // 9. Generic text generation via the TextProvider interface — no
    //    provider-specific code, ever.
    const textProvider = chosen.adapter as TextProvider;
    let rawText: string;
    try {
      const result = await textProvider.generateText({
        prompt: builtPrompt.userPrompt,
        systemPrompt: builtPrompt.systemPrompt,
        modelId: chosen.model.modelId,
      });
      rawText = result.text;
    } catch (err) {
      // ProviderError is sanitized by construction (credential-free); any
      // other error is collapsed to a generic message so no unexpected
      // detail can ever escape. Either way nothing has been written yet.
      if (err instanceof ProviderError) {
        throw new SceneGenerationError(`Scene generation failed: ${err.message}`, 502);
      }
      throw new SceneGenerationError(
        "Scene generation failed due to an unexpected provider error.",
        502,
      );
    }

    // 10. Parse + Zod-validate the model output against the shared contract.
    //     A response that fails here throws before any write.
    const generated = parseSceneResponse(rawText);

    // 11. Persist: replace the previously generated (tracked) scene set with
    //     the new validated set, preserving every manually created scene.
    //     The tracked set was safety-checked in step 6 (no shots, still on
    //     this episode); only after all inserts succeed is the plan payload
    //     updated with the new scene references.
    if (replaceable.length > 0) {
      // Concurrency safeguard (C7.4 review M1): shots may have been created
      // while the provider was generating. Re-run the shot check so every
      // tracked scene is re-verified BEFORE the first deletion; a newly
      // detected shot aborts here with nothing deleted.
      await this.assertScenesHaveNoShots(db, replaceable);
      for (const id of replaceable) {
        await getDb().delete(scenes).where(eq(scenes.id, id));
      }
    }

    // orderIndex continues after the episode's current maximum; with no
    // existing scenes the first generated scene gets orderIndex 1 (the
    // domain's positive-integer convention).
    const startOrderIndex = (await this.maxSceneOrderIndex(db, episode.id)) + 1;
    let nextOrderIndex = startOrderIndex;
    const insertedIds: string[] = [];
    try {
      for (const scene of generated.scenes) {
        const [created] = await getDb()
          .insert(scenes)
          .values({
            episodeId: episode.id,
            name: scene.name,
            description: scene.description,
            orderIndex: nextOrderIndex,
          })
          .$returningId();
        if (!created || typeof created.id !== "string") {
          throw new SceneGenerationError("Failed to create the generated scenes", 502);
        }
        insertedIds.push(created.id);
        nextOrderIndex += 1;
      }
    } catch (err) {
      if (err instanceof SceneGenerationError) throw err;
      throw new Error("Failed to persist the generated scenes", { cause: err });
    }

    const nextPlan = this.withSceneReferences(existing.plan, insertedIds);

    try {
      await getDb()
        .update(productionPlans)
        .set({ plan: nextPlan })
        .where(eq(productionPlans.id, input.productionPlanId));
    } catch (err) {
      throw new Error("Failed to record the scenes on the production plan", { cause: err });
    }

    return {
      episode,
      scenes: generated.scenes.map((scene, index) => ({
        id: insertedIds[index] as string,
        episodeId: episode.id,
        name: scene.name,
        description: scene.description,
        orderIndex: startOrderIndex + index,
      })),
      scriptVersion: { id: script.id, version: script.version },
      plan: nextPlan,
    };
  }

  /**
   * Extracts and re-validates the story from the plan payload. The payload
   * is user-editable (C7.1 PATCH), so it is validated again here rather than
   * trusted; anything story-shaped-but-invalid is treated as absent.
   */
  extractStoryFromPlan(plan: unknown): StoryContract | null {
    if (!isPlainObject(plan)) return null;
    const result = storyContractSchema.safeParse(plan.story);
    return result.success ? result.data : null;
  }

  /**
   * Extracts the tracked generated-scene ids from the plan payload. Anything
   * that is not a non-empty string is ignored, so a corrupted list can never
   * turn into a destructive wildcard.
   */
  extractSceneIdsFromPlan(plan: unknown): string[] {
    if (!isPlainObject(plan)) return [];
    const raw = plan.sceneIds;
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  /**
   * Finds the episode the generated scenes belong to, in priority order: the
   * plan's anchored episodeId, then the episode recorded by a previous
   * generation. The candidate is verified to exist within the plan's project
   * (404 otherwise), so a wrong project/episode/plan relationship can never
   * pass.
   */
  private async findReferencedEpisode(
    db: DbLike,
    projectId: string,
    plan: { episodeId: string | null; plan: unknown },
  ): Promise<SceneGenerationResult["episode"]> {
    const planPayload = isPlainObject(plan.plan) ? plan.plan : null;
    const recordedEpisodeId =
      planPayload && typeof planPayload.episodeId === "string" ? planPayload.episodeId : null;

    const episodeId =
      typeof plan.episodeId === "string" ? plan.episodeId : recordedEpisodeId;
    if (!episodeId) {
      throw new SceneGenerationError(
        "No episode is associated with this production plan yet. Generate a script first (C7.3) or anchor the plan to an existing episode.",
        404,
      );
    }

    const rows = await db
      .select({
        id: episodes.id,
        projectId: episodes.projectId,
        title: episodes.title,
        episodeNumber: episodes.episodeNumber,
        status: episodes.status,
      })
      .from(episodes)
      .where(and(eq(episodes.id, episodeId), eq(episodes.projectId, projectId)));
    const row = rows[0];
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.projectId !== "string" ||
      typeof row.title !== "string" ||
      typeof row.episodeNumber !== "number" ||
      typeof row.status !== "string"
    ) {
      throw new SceneGenerationError(
        "The episode anchored to this production plan was not found in its project",
        404,
      );
    }
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      episodeNumber: row.episodeNumber,
      status: row.status,
    };
  }

  /**
   * Resolves and revalidates the script the scene list must be derived from.
   *
   * Priority: the explicitly referenced `plan.scriptVersionId` (must exist
   * AND belong to the resolved episode — a missing or cross-episode
   * reference is a 404 and is NEVER silently replaced by another version),
   * else the highest script version on the episode. Content is parsed and
   * revalidated against the shared contract; manual content is not
   * automatically trusted. A missing or invalid script is a 400: scene
   * generation without a valid script is a validation error, never a
   * silent invention.
   */
  private async resolveScript(
    db: DbLike,
    episodeId: string,
    plan: unknown,
  ): Promise<ScriptContract & { id: string; version: number }> {
    const planPayload = isPlainObject(plan) ? plan : null;
    const referencedScriptVersionId =
      planPayload && typeof planPayload.scriptVersionId === "string"
        ? planPayload.scriptVersionId
        : null;

    let scriptRow: { id: string; version: number; content: string } | null = null;
    if (referencedScriptVersionId !== null) {
      const rows = await db
        .select({
          id: scripts.id,
          episodeId: scripts.episodeId,
          version: scripts.version,
          content: scripts.content,
        })
        .from(scripts)
        .where(eq(scripts.id, referencedScriptVersionId));
      const row = rows[0];
      // Explicit reference: existence + episode ownership are structural
      // relationship checks (404), validated against the DB types, never a
      // silent fallback to a different script version.
      if (
        !row ||
        typeof row.id !== "string" ||
        typeof row.episodeId !== "string" ||
        typeof row.version !== "number" ||
        typeof row.content !== "string" ||
        row.episodeId !== episodeId
      ) {
        throw new SceneGenerationError(
          "The script version referenced by this production plan was not found for its episode",
          404,
        );
      }
      scriptRow = { id: row.id, version: row.version, content: row.content };
    } else {
      const rows = await db
        .select({ id: scripts.id, version: scripts.version, content: scripts.content })
        .from(scripts)
        .where(eq(scripts.episodeId, episodeId));
      let best: { id: string; version: number; content: string } | null = null;
      for (const row of rows) {
        if (
          typeof row.id !== "string" ||
          typeof row.version !== "number" ||
          !Number.isFinite(row.version)
        ) {
          continue;
        }
        if (best === null || row.version > best.version) {
          best = {
            id: row.id,
            version: row.version,
            content: typeof row.content === "string" ? row.content : "",
          };
        }
      }
      if (!best) {
        throw new SceneGenerationError(
          "No script has been generated for this episode yet. Generate a script first (C7.3) before generating scenes.",
          400,
        );
      }
      scriptRow = best;
    }

    // Content revalidation: manual script content is not automatically
    // trusted (the manual route accepts arbitrary strings). Corrupted or
    // contract-invalid content is a 400 — with no silent fallback.
    const parsed = this.parseScriptContent(scriptRow.content);
    if (!parsed) {
      throw new SceneGenerationError(
        "The script for this episode is not a valid script document. Generate a valid script (C7.3) before generating scenes.",
        400,
      );
    }
    return { id: scriptRow.id, version: scriptRow.version, ...parsed };
  }

  /** Parses and contract-validates stored script JSON content. */
  private parseScriptContent(content: string): ScriptContract | null {
    try {
      const parsed: unknown = JSON.parse(content);
      const result = scriptContractSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves which tracked scene ids are safe to replace. Every id must
   * still belong to the resolved episode; ones that do not (manually
   * deleted, or moved by a payload edit) are skipped safely. If ANY tracked
   * scene still has shots referencing it, regeneration aborts with a 409
   * BEFORE any destructive change — scenes and shots remain untouched.
   */
  private async resolveReplaceableScenes(
    db: DbLike,
    episodeId: string,
    previousSceneIds: string[],
  ): Promise<string[]> {
    const trackedEpisodeById = new Map<string, string>();
    for (const id of previousSceneIds) {
      const rows = await db
        .select({ id: scenes.id, episodeId: scenes.episodeId })
        .from(scenes)
        .where(eq(scenes.id, id));
      const row = rows[0];
      if (row && typeof row.id === "string" && typeof row.episodeId === "string") {
        trackedEpisodeById.set(row.id, row.episodeId);
      }
    }

    const replaceable: string[] = [];
    for (const id of previousSceneIds) {
      const rowEpisodeId = trackedEpisodeById.get(id);
      if (rowEpisodeId === undefined) continue; // manually deleted — skip
      if (rowEpisodeId !== episodeId) continue; // no longer on this episode — skip
      replaceable.push(id);
    }

    if (replaceable.length === 0) return [];

    // Shots live on the same rows: any tracked scene with shots blocks the
    // replacement, preserving both the scene and its shots.
    await this.assertScenesHaveNoShots(db, replaceable);

    return replaceable;
  }

  /**
   * Throws the shot-preservation 409 when ANY of the given scenes has shots.
   * Runs once before the provider call (the regeneration gate) and again
   * immediately before the tracked set is deleted, so a shot created while
   * generation was in flight still aborts the regeneration BEFORE the first
   * deletion happens — never leaving a partially deleted tracked set.
   */
  private async assertScenesHaveNoShots(db: DbLike, sceneIds: string[]): Promise<void> {
    for (const id of sceneIds) {
      const shotRows = await db
        .select({ sceneId: shots.sceneId })
        .from(shots)
        .where(eq(shots.sceneId, id));
      if (shotRows.length > 0) {
        throw new SceneGenerationError(
          "Regenerated scenes already have shots. Scenes with existing shots cannot currently be regenerated; keep the existing scenes or delete their shots first.",
          409,
        );
      }
    }
  }

  /** Highest `orderIndex` on an episode, or 0 when it has none. */
  private async maxSceneOrderIndex(db: DbLike, episodeId: string): Promise<number> {
    const rows = await db
      .select({ orderIndex: scenes.orderIndex })
      .from(scenes)
      .where(eq(scenes.episodeId, episodeId));
    let max = 0;
    for (const row of rows) {
      if (typeof row.orderIndex === "number" && Number.isFinite(row.orderIndex) && row.orderIndex > max) {
        max = row.orderIndex;
      }
    }
    return max;
  }

  /**
   * Merges the generated-scene references into the plan payload, preserving
   * every unrelated key — including the story, episode/script references,
   * and any user payload keys. Only the `sceneIds` reference key is written.
   */
  private withSceneReferences(
    plan: unknown,
    sceneIds: string[],
  ): Record<string, unknown> {
    const base = isPlainObject(plan) ? plan : {};
    return { ...base, sceneIds };
  }
}

export const sceneGenerationService = new SceneGenerationService();
