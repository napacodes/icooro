import { and, eq } from "drizzle-orm";
import {
  shotListContractSchema,
  scriptContractSchema,
  storyContractSchema,
  type ShotListContract,
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
import { buildShotPrompt, type ShotPromptSceneContext } from "./shot_prompt.js";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import { episodes } from "../db/schema/episodes.js";
import { scripts } from "../db/schema/scripts.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { shotVersions } from "../db/schema/shot_versions.js";
import { shotCharacters } from "../db/schema/shot_characters.js";
import { shotLocations } from "../db/schema/shot_locations.js";
import { shotProps } from "../db/schema/shot_props.js";
import { shotAssets } from "../db/schema/shot_assets.js";
import { productionPlans } from "../db/schema/production_plans.js";

/**
 * Shot generation (C7.5): the fourth AI-assisted Production Director step.
 *
 * ProductionPlan → validated Story + Script + Scene → Shot Generator
 * (generic text provider) → structured shot list → rows in the EXISTING
 * `shots` table
 *
 * Orchestration, not duplication: generated shots become ordinary rows of
 * the target scene — no parallel shot model and NO `shot_versions` writes
 * (that table stays media-generation history, C4/C5). The plan records only
 * the reference: `plan.shotIds` maps the target scene's id to the ids of the
 * generated shot set, merged over the existing payload so every unrelated
 * key (story, episodeId, scriptVersionId, sceneIds, user keys) survives.
 *
 * Integration rules (same as C7.2–C7.4):
 * - The service depends ONLY on the C6.7/C6.8 provider abstraction
 *   (`findAdaptersForCapability` routing + the generic `TextProvider`
 *   interface). It never names a specific provider (OpenAI/Gemini/ChatFire)
 *   and performs no provider-specific request or response handling.
 * - Generation is planning-time and synchronous: no media GenerationJob, no
 *   background worker, no invented text job type.
 * - A story, a script, and a scene of the resolved episode are ALL
 *   REQUIRED: generation without them is a validation error, never a
 *   silent invention.
 * - Every safety check (story/script/scene chain and the dependent-data
 *   gate over shot_versions/shot_characters/shot_locations/shot_props/
 *   shot_assets) runs BEFORE any destructive change or provider call, and
 *   the dependent-data gate runs AGAIN immediately before the first
 *   deletion (C7.4's M1 pattern), so a shot created during generation
 *   still aborts the regeneration BEFORE any tracked shot is deleted.
 * - KNOWN LIMITATION (non-transactional, repo-wide convention): the
 *   delete → insert → plan-payload-update sequence is not atomic. A
 *   mid-flight failure after deletions can leave untracked orphan rows;
 *   a later regeneration treats those ids as gone (skip) and appends a
 *   fresh set rather than silently duplicating. Same documented posture
 *   as C7.3/C7.4.
 */

/** The only plan status from which shot generation may run (planning-time AI). */
const GENERATION_ALLOWED_STATUS = "planning";

export class ShotGenerationError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(message: string, status: 400 | 404 | 409 | 502 = 502) {
    super(message);
    this.name = "ShotGenerationError";
    this.status = status;
  }
}

/**
 * Extract the first JSON object from model text (tolerating fences and stray
 * prose). Same parsing contract as C7.2–C7.4's generators.
 */
export function extractShotJsonObject(text: string): unknown {
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

  throw new ShotGenerationError(
    "The AI response did not contain a valid JSON object.",
    502,
  );
}

/**
 * Parse and validate raw model output against the shared shot-list
 * contract. The validated (unknown-key-stripped) object is the only thing
 * that ever reaches the `shots` table.
 */
export function parseShotResponse(rawText: string): ShotListContract {
  const parsed = extractShotJsonObject(rawText);
  const result = shotListContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new ShotGenerationError(
      "The AI response did not match the required shot structure.",
      502,
    );
  }
  return result.data;
}

export interface ShotGenerationInput {
  projectId: string;
  productionPlanId: string;
  sceneId: string;
}

export interface ShotGenerationResult {
  /** The scene the shots were written to. */
  scene: { id: string; episodeId: string; name: string; description: string | null };
  /** The newly generated shot rows (in narrative order). */
  shots: Array<{
    id: string;
    sceneId: string;
    purpose: string;
    shotType: string;
    framing: string;
    cameraMovement: string;
    cameraAngle: string;
    actionDescription: string;
    visualDescription: string;
    transition: string;
    duration: number;
    orderIndex: number;
    status: string;
  }>;
  /** The script version the shot list was derived from. */
  scriptVersion: { id: string; version: number };
  /** The updated plan payload (`shotIds` merged, all other keys preserved). */
  plan: Record<string, unknown>;
}

/**
 * Deterministic model choice — identical rule to C7.2–C7.4's generators
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

export class ShotGenerationService {
  /**
   * Generates (or regenerates) a structured shot list for ONE scene from
   * the plan's story and script and persists it as rows in the scene's
   * existing `shots` table. Planning-time only: allowed solely while the
   * plan is in `planning` status. Ownership is enforced by the caller: the
   * route checks project ownership C7.1-style, and every lookup below is
   * scoped to the project via the plan → episode → scene chain.
   */
  async generateShotsForScene(input: ShotGenerationInput): Promise<ShotGenerationResult> {
    const db: DbLike = getDb();

    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const existing = await productionPlanService.getPlan(
      input.productionPlanId,
      input.projectId,
    );
    if (!existing) {
      throw new ShotGenerationError("Production plan not found", 404);
    }

    // 2. State gate: shot generation is planning-time only.
    if (existing.status !== GENERATION_ALLOWED_STATUS) {
      throw new ShotGenerationError(
        `Shots can only be generated while the production plan is in "${GENERATION_ALLOWED_STATUS}" status (current status: "${existing.status}")`,
        409,
      );
    }

    // 3. Story REQUIRED: re-validated from the payload (user-editable).
    const story = this.extractStoryFromPlan(existing.plan);
    if (!story) {
      throw new ShotGenerationError(
        "No story has been generated for this production plan yet. Generate a story first (C7.2) before generating shots.",
        400,
      );
    }

    // 4. Episode relationship precondition: C7.3/C7.4 precedence (plan row's
    //    episodeId, then the payload's episodeId), verified within the
    //    project BEFORE any provider work.
    const episode = await this.findReferencedEpisode(db, input.projectId, existing);

    // 5. Target scene: must exist AND belong to the resolved episode — a
    //    cross-episode or cross-project scene is an indistinguishable 404.
    const scene = await this.findTargetScene(db, episode.id, input.sceneId);

    // 6. Script REQUIRED: C7.4's resolve + revalidate semantics, BEFORE any
    //    provider call.
    const script = await this.resolveScript(db, episode.id, existing.plan);

    // 7. Regeneration safety: resolved BEFORE any destructive change or
    //    provider call; the dependent-data gate inside aborts with a 409.
    const previousShotIds = this.extractTrackedShotIds(existing.plan, input.sceneId);
    const replaceable =
      previousShotIds.length > 0
        ? await this.resolveReplaceableShots(db, input.sceneId, previousShotIds)
        : [];

    // 8. Prompt construction (dedicated builder; request + story + script +
    //    scene). All persistence happens strictly after output validation.
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const projectName = typeof project?.name === "string" ? project.name : null;
    const sceneContext: ShotPromptSceneContext = {
      name: scene.name,
      description: scene.description ?? null,
    };
    const builtPrompt = buildShotPrompt({
      plan: {
        request: existing.request,
        targetDurationSeconds: existing.targetDurationSeconds,
        preferences: existing.preferences,
      },
      story,
      script,
      scene: sceneContext,
    });

    // 9. Model selection through the existing C6.8 capability routing —
    //    capability "text", adapter-constructible candidates only.
    const candidates = await findAdaptersForCapability({ db, capability: "text" });
    if (candidates.length === 0) {
      throw new ShotGenerationError(
        "No enabled text model is configured for shot generation.",
        400,
      );
    }
    const chosen = [...candidates].sort(compareByCreatedAt)[0];
    if (!chosen) {
      throw new ShotGenerationError(
        "No enabled text model is configured for shot generation.",
        400,
      );
    }

    // 10. Generic text generation via the TextProvider interface — no
    //     provider-specific code, ever.
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
        throw new ShotGenerationError(`Shot generation failed: ${err.message}`, 502);
      }
      throw new ShotGenerationError(
        "Shot generation failed due to an unexpected provider error.",
        502,
      );
    }

    // 11. Parse + Zod-validate the model output against the shared contract.
    //     A response that fails here throws before any write.
    const generated = parseShotResponse(rawText);

    // 12. Persist: replace the previously generated (tracked) shot set of
    //     THIS scene with the new validated set, preserving every manually
    //     created shot. The dependent-data gate is re-checked immediately
    //     before the first deletion (C7.4 M1 pattern): all tracked shots are
    //     re-verified before any delete, so a shot or dependency created
    //     while the provider was generating aborts with nothing deleted.
    if (replaceable.length > 0) {
      await this.assertShotsHaveNoDependentData(db, replaceable);
      for (const id of replaceable) {
        await getDb().delete(shots).where(eq(shots.id, id));
      }
    }

    // orderIndex continues after the scene's current maximum; with no
    // existing shots the first generated shot gets orderIndex 1 (the
    // domain's positive-integer convention). Manual shots are preserved.
    const startOrderIndex = (await this.maxShotOrderIndex(db, input.sceneId)) + 1;
    let nextOrderIndex = startOrderIndex;
    const insertedIds: string[] = [];
    try {
      for (const shot of generated.shots) {
        const [created] = await getDb()
          .insert(shots)
          .values({
            sceneId: input.sceneId,
            orderIndex: nextOrderIndex,
            purpose: shot.purpose,
            shotType: shot.shotType,
            framing: shot.framing,
            cameraMovement: shot.cameraMovement,
            cameraAngle: shot.cameraAngle,
            actionDescription: shot.actionDescription,
            visualDescription: shot.visualDescription,
            transition: shot.transition,
            duration: shot.duration,
            status: "pending",
          })
          .$returningId();
        if (!created || typeof created.id !== "string") {
          throw new ShotGenerationError("Failed to create the generated shots", 502);
        }
        insertedIds.push(created.id);
        nextOrderIndex += 1;
      }
    } catch (err) {
      if (err instanceof ShotGenerationError) throw err;
      throw new Error("Failed to persist the generated shots", { cause: err });
    }

    const nextPlan = this.withShotReferences(existing.plan, input.sceneId, insertedIds);

    try {
      await getDb()
        .update(productionPlans)
        .set({ plan: nextPlan })
        .where(eq(productionPlans.id, input.productionPlanId));
    } catch (err) {
      throw new Error("Failed to record the shots on the production plan", { cause: err });
    }

    return {
      scene: { id: scene.id, episodeId: scene.episodeId, name: scene.name, description: scene.description },
      shots: generated.shots.map((shot, index) => ({
        id: insertedIds[index] as string,
        sceneId: input.sceneId,
        purpose: shot.purpose,
        shotType: shot.shotType,
        framing: shot.framing,
        cameraMovement: shot.cameraMovement,
        cameraAngle: shot.cameraAngle,
        actionDescription: shot.actionDescription,
        visualDescription: shot.visualDescription,
        transition: shot.transition,
        duration: shot.duration,
        orderIndex: startOrderIndex + index,
        status: "pending",
      })),
      scriptVersion: { id: script.id, version: script.version },
      plan: nextPlan,
    };
  }

  /**
   * Extracts and re-validates the story from the plan payload. The payload
   * is user-editable (C7.1 PATCH), so it is validated again here rather
   * than trusted; anything story-shaped-but-invalid is treated as absent.
   */
  extractStoryFromPlan(plan: unknown): StoryContract | null {
    if (!isPlainObject(plan)) return null;
    const result = storyContractSchema.safeParse(plan.story);
    return result.success ? result.data : null;
  }

  /**
   * Extracts the tracked generated-shot ids for ONE scene from the plan
   * payload's `shotIds` map (scene id → string[]). Non-object shapes,
   * non-arrays, and non-string entries are ignored, so a corrupted map can
   * never turn into a destructive wildcard.
   */
  extractTrackedShotIds(plan: unknown, sceneId: string): string[] {
    if (!isPlainObject(plan)) return [];
    const raw = plan.shotIds;
    if (!isPlainObject(raw)) return [];
    const sceneEntry = raw[sceneId];
    if (!Array.isArray(sceneEntry)) return [];
    return sceneEntry.filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  /**
   * Finds the episode the shots belong to, in priority order: the plan's
   * anchored episodeId, then the episode recorded by a previous generation.
   * The candidate is verified to exist within the plan's project (404
   * otherwise), so a wrong project/episode/plan relationship can never pass.
   */
  private async findReferencedEpisode(
    db: DbLike,
    projectId: string,
    plan: { episodeId: string | null; plan: unknown },
  ): Promise<{ id: string; projectId: string; title: string; episodeNumber: number; status: string }> {
    const planPayload = isPlainObject(plan.plan) ? plan.plan : null;
    const recordedEpisodeId =
      planPayload && typeof planPayload.episodeId === "string" ? planPayload.episodeId : null;

    const episodeId =
      typeof plan.episodeId === "string" ? plan.episodeId : recordedEpisodeId;
    if (!episodeId) {
      throw new ShotGenerationError(
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
      throw new ShotGenerationError(
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
   * Resolves the target scene: it must exist AND belong to the resolved
   * episode. A scene of another episode (or another project) is an
   * indistinguishable 404 — no cross-tenant information is disclosed.
   */
  private async findTargetScene(
    db: DbLike,
    episodeId: string,
    sceneId: string,
  ): Promise<{ id: string; episodeId: string; name: string; description: string | null }> {
    const rows = await db
      .select({ id: scenes.id, episodeId: scenes.episodeId, name: scenes.name, description: scenes.description })
      .from(scenes)
      .where(and(eq(scenes.id, sceneId), eq(scenes.episodeId, episodeId)));
    const row = rows[0];
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.episodeId !== "string" ||
      typeof row.name !== "string" ||
      (row.description !== null && typeof row.description !== "string")
    ) {
      throw new ShotGenerationError(
        "The scene was not found in the episode associated with this production plan",
        404,
      );
    }
    return { id: row.id, episodeId: row.episodeId, name: row.name, description: row.description };
  }

  /**
   * Resolves and revalidates the script the shot list must be derived from.
   * Identical semantics to C7.4's scene generator: the explicitly referenced
   * `plan.scriptVersionId` must exist AND belong to the resolved episode
   * (404 otherwise, never silently replaced), else the highest script
   * version on the episode is used (none → 400). Stored content is parsed
   * and revalidated against the shared contract; manual content is not
   * automatically trusted. Invalid content is a 400 with no fallback.
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
      if (
        !row ||
        typeof row.id !== "string" ||
        typeof row.episodeId !== "string" ||
        typeof row.version !== "number" ||
        typeof row.content !== "string" ||
        row.episodeId !== episodeId
      ) {
        throw new ShotGenerationError(
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
        throw new ShotGenerationError(
          "No script has been generated for this episode yet. Generate a script first (C7.3) before generating shots.",
          400,
        );
      }
      scriptRow = best;
    }

    const parsed = this.parseScriptContent(scriptRow.content);
    if (!parsed) {
      throw new ShotGenerationError(
        "The script for this episode is not a valid script document. Generate a valid script (C7.3) before generating shots.",
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
   * Resolves which tracked shot ids are safe to replace for the target
   * scene. Every id must still exist AND still belong to the target scene;
   * ones that do not (manually deleted, or moved by a payload edit) are
   * skipped safely. Any tracked shot with dependent rows (shot_versions,
   * shot_characters, shot_locations, shot_props, shot_assets) aborts
   * regeneration with a 409 BEFORE any destructive change.
   */
  private async resolveReplaceableShots(
    db: DbLike,
    sceneId: string,
    previousShotIds: string[],
  ): Promise<string[]> {
    const trackedSceneById = new Map<string, string>();
    for (const id of previousShotIds) {
      const rows = await db
        .select({ id: shots.id, sceneId: shots.sceneId })
        .from(shots)
        .where(eq(shots.id, id));
      const row = rows[0];
      if (row && typeof row.id === "string" && typeof row.sceneId === "string") {
        trackedSceneById.set(row.id, row.sceneId);
      }
    }

    const replaceable: string[] = [];
    for (const id of previousShotIds) {
      const rowSceneId = trackedSceneById.get(id);
      if (rowSceneId === undefined) continue; // manually deleted — skip
      if (rowSceneId !== sceneId) continue; // moved to another scene — skip
      replaceable.push(id);
    }

    if (replaceable.length === 0) return [];

    // Dependent data blocks the replacement (409), preserving the shot and
    // everything hanging off it.
    await this.assertShotsHaveNoDependentData(db, replaceable);

    return replaceable;
  }

  /**
   * Throws the dependent-data 409 when ANY of the given shots has rows in
   * shot_versions, shot_characters, shot_locations, shot_props, or
   * shot_assets. Runs once before the provider call (the regeneration
   * gate) and again immediately before the tracked set is deleted (the
   * C7.4 M1 concurrency pattern): all shots are re-verified before the
   * first deletion, so a dependency created during generation aborts with
   * nothing deleted.
   */
  private async assertShotsHaveNoDependentData(db: DbLike, shotIds: string[]): Promise<void> {
    const dependentTables: Array<{ label: string; select: () => Promise<unknown[]> }> = [
      {
        label: "shot versions",
        select: async () => {
          const out: unknown[] = [];
          for (const id of shotIds) {
            const rows = await db
              .select({ shotId: shotVersions.shotId })
              .from(shotVersions)
              .where(eq(shotVersions.shotId, id));
            out.push(...rows);
          }
          return out;
        },
      },
      {
        label: "shot characters",
        select: async () => {
          const out: unknown[] = [];
          for (const id of shotIds) {
            const rows = await db
              .select({ shotId: shotCharacters.shotId })
              .from(shotCharacters)
              .where(eq(shotCharacters.shotId, id));
            out.push(...rows);
          }
          return out;
        },
      },
      {
        label: "shot locations",
        select: async () => {
          const out: unknown[] = [];
          for (const id of shotIds) {
            const rows = await db
              .select({ shotId: shotLocations.shotId })
              .from(shotLocations)
              .where(eq(shotLocations.shotId, id));
            out.push(...rows);
          }
          return out;
        },
      },
      {
        label: "shot props",
        select: async () => {
          const out: unknown[] = [];
          for (const id of shotIds) {
            const rows = await db
              .select({ shotId: shotProps.shotId })
              .from(shotProps)
              .where(eq(shotProps.shotId, id));
            out.push(...rows);
          }
          return out;
        },
      },
      {
        label: "shot assets",
        select: async () => {
          const out: unknown[] = [];
          for (const id of shotIds) {
            const rows = await db
              .select({ shotId: shotAssets.shotId })
              .from(shotAssets)
              .where(eq(shotAssets.shotId, id));
            out.push(...rows);
          }
          return out;
        },
      },
    ];

    for (const table of dependentTables) {
      const rows = await table.select();
      if (rows.length > 0) {
        throw new ShotGenerationError(
          "Regenerated shots already have dependent data (versions, characters, locations, props, or assets). Shots with existing dependent data cannot currently be regenerated; keep the existing shots or delete their dependent data first.",
          409,
        );
      }
    }
  }

  /** Highest `orderIndex` on a scene, or 0 when it has none. */
  private async maxShotOrderIndex(db: DbLike, sceneId: string): Promise<number> {
    const rows = await db
      .select({ orderIndex: shots.orderIndex })
      .from(shots)
      .where(eq(shots.sceneId, sceneId));
    let max = 0;
    for (const row of rows) {
      if (typeof row.orderIndex === "number" && Number.isFinite(row.orderIndex) && row.orderIndex > max) {
        max = row.orderIndex;
      }
    }
    return max;
  }

  /**
   * Merges the generated-shot references into the plan payload's `shotIds`
   * map (scene id → ids), preserving every unrelated key — including the
   * story, episode/script/scene references, other scenes' shot sets, and
   * any user payload keys. Only this scene's entry is rewritten.
   */
  private withShotReferences(
    plan: unknown,
    sceneId: string,
    shotIds: string[],
  ): Record<string, unknown> {
    const base = isPlainObject(plan) ? plan : {};
    const baseShotIds = isPlainObject(base.shotIds) ? base.shotIds : {};
    return { ...base, shotIds: { ...baseShotIds, [sceneId]: shotIds } };
  }
}

export const shotGenerationService = new ShotGenerationService();
