import { and, asc, eq } from "drizzle-orm";
import {
  scriptContractSchema,
  storyContractSchema,
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
import { buildScriptPrompt } from "./script_prompt.js";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import { episodes } from "../db/schema/episodes.js";
import { scripts } from "../db/schema/scripts.js";
import { productionPlans } from "../db/schema/production_plans.js";

/**
 * Script generation (C7.3): the second AI-assisted Production Director step.
 *
 * ProductionPlan → validated Story → Script Generator (generic text provider)
 * → structured script → Episode + ScriptVersion
 *
 * Orchestration, not duplication: the generator writes into the EXISTING
 * C2/C3 domain. The validated script becomes the JSON `content` of a NEW
 * ScriptVersion row on the plan's episode (creating the episode when the
 * plan is unanchored); previous ScriptVersions are never touched. The plan
 * records only the reference (`plan.episodeId` / `plan.scriptVersionId`).
 *
 * Integration rules (same as C7.2):
 * - The service depends ONLY on the C6.7/C6.8 provider abstraction
 *   (`findAdaptersForCapability` routing + the generic `TextProvider`
 *   interface). It never names a specific provider (OpenAI/Gemini/ChatFire)
 *   and performs no provider-specific request or response handling.
 * - Generation is planning-time and synchronous: no media GenerationJob, no
 *   background worker, no invented text job type.
 * - A story is REQUIRED: generation without one is a validation error, never
 *   a silent invention.
 * - A failed generation throws BEFORE any write: no episode, no script
 *   version, no plan payload change. Failed regenerations leave every
 *   previous script version intact.
 */

/** The only plan status from which script generation may run (planning-time AI). */
const GENERATION_ALLOWED_STATUS = "planning";

export class ScriptGenerationError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(message: string, status: 400 | 404 | 409 | 502 = 502) {
    super(message);
    this.name = "ScriptGenerationError";
    this.status = status;
  }
}

/**
 * Extract the first JSON object from model text (tolerating fences and stray
 * prose). Same parsing contract as C7.2's story generator.
 */
export function extractScriptJsonObject(text: string): unknown {
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

  throw new ScriptGenerationError(
    "The AI response did not contain a valid JSON object.",
    502,
  );
}

/**
 * Parse and validate raw model output against the shared script contract.
 * The validated (unknown-key-stripped) object is the only thing that ever
 * reaches the script content.
 */
export function parseScriptResponse(rawText: string): ScriptContract {
  const parsed = extractScriptJsonObject(rawText);
  const result = scriptContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScriptGenerationError(
      "The AI response did not match the required script structure.",
      502,
    );
  }
  return result.data;
}

export interface ScriptGenerationInput {
  projectId: string;
  productionPlanId: string;
}

export interface ScriptGenerationResult {
  /** The episode the script version was written to. */
  episode: { id: string; projectId: string; title: string; episodeNumber: number; status: string };
  /** The newly created script version. */
  scriptVersion: { id: string; episodeId: string; version: number; content: string };
  /** All versions now on the episode (ascending), previous ones preserved. */
  versions: Array<{ id: string; version: number }>;
  /** The updated plan payload (reference keys merged, story untouched). */
  plan: Record<string, unknown>;
}

/**
 * Deterministic model choice — identical rule to C7.2's story generator
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

export class ScriptGenerationService {
  /**
   * Generates (or regenerates) a structured script from the plan's story and
   * persists it as a new ScriptVersion on the plan's episode. Planning-time
   * only: allowed solely while the plan is in `planning` status. Ownership is
   * enforced by the caller: the route checks project ownership C7.1-style,
   * and every lookup below is scoped to the project.
   */
  async generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult> {
    const db: DbLike = getDb();

    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const existing = await productionPlanService.getPlan(
      input.productionPlanId,
      input.projectId,
    );
    if (!existing) {
      throw new ScriptGenerationError("Production plan not found", 404);
    }

    // 2. State gate: script generation is planning-time only.
    if (existing.status !== GENERATION_ALLOWED_STATUS) {
      throw new ScriptGenerationError(
        `Script can only be generated while the production plan is in "${GENERATION_ALLOWED_STATUS}" status (current status: "${existing.status}")`,
        409,
      );
    }

    // 3. Story REQUIRED: never silently invent one.
    const story = this.extractStoryFromPlan(existing.plan);
    if (!story) {
      throw new ScriptGenerationError(
        "No story has been generated for this production plan yet. Generate a story first (C7.2) before generating a script.",
        400,
      );
    }

    // 4. Episode relationship precondition: when the plan references an
    //    episode (anchored or recorded by a previous generation), verify it
    //    exists within the project BEFORE any provider work, so a wrong
    //    project/episode/plan relationship fails fast as a 404 with zero
    //    side effects.
    const referencedEpisode = await this.findReferencedEpisode(db, input.projectId, existing);

    // 5. Prompt construction (dedicated builder; request + story + context).
    //    Episode CREATION still happens after output validation so that
    //    every failure path (no model, provider error, malformed/invalid
    //    output) throws before any row is written.
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const projectName = typeof project?.name === "string" ? project.name : null;
    const builtPrompt = buildScriptPrompt({
      plan: {
        request: existing.request,
        targetDurationSeconds: existing.targetDurationSeconds,
        preferences: existing.preferences,
      },
      story,
      projectName,
    });

    // 5. Model selection through the existing C6.8 capability routing —
    //    capability "text", adapter-constructible candidates only.
    const candidates = await findAdaptersForCapability({ db, capability: "text" });
    if (candidates.length === 0) {
      throw new ScriptGenerationError(
        "No enabled text model is configured for script generation.",
        400,
      );
    }
    const chosen = [...candidates].sort(compareByCreatedAt)[0];
    if (!chosen) {
      throw new ScriptGenerationError(
        "No enabled text model is configured for script generation.",
        400,
      );
    }

    // 6. Generic text generation via the TextProvider interface — no
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
        throw new ScriptGenerationError(`Script generation failed: ${err.message}`, 502);
      }
      throw new ScriptGenerationError(
        "Script generation failed due to an unexpected provider error.",
        502,
      );
    }

    // 7. Parse + Zod-validate the model output against the shared contract.
    //    A response that fails here throws before any write.
    const script = parseScriptResponse(rawText);

    // 8. Persist: resolve the target episode — the one verified in step 4,
    //    else create one titled from the story — then insert a NEW
    //    ScriptVersion (highest version + 1). Previous versions are never
    //    modified or deleted. Only after the insert succeeds is the plan
    //    payload updated with the episode reference. If the plan update
    //    fails, the already-created version remains (a harmless orphan: the
    //    next attempt computes max+1 rather than plan-derived).
    const episode =
      referencedEpisode ??
      (await this.createEpisodeForPlan(db, input.projectId, story.title));
    const nextVersion = (await this.maxScriptVersion(db, episode.id)) + 1;
    const [created] = await getDb()
      .insert(scripts)
      .values({
        episodeId: episode.id,
        version: nextVersion,
        content: JSON.stringify(script, null, 2),
      })
      .$returningId();
    if (!created) {
      throw new ScriptGenerationError("Failed to create the script version", 502);
    }

    const nextPlan = this.withScriptReferences(existing.plan, episode.id, created.id);

    try {
      await getDb()
        .update(productionPlans)
        .set({ plan: nextPlan })
        .where(eq(productionPlans.id, input.productionPlanId));
    } catch (err) {
      throw new Error("Failed to record the script on the production plan", { cause: err });
    }

    const versions = await getDb()
      .select({ id: scripts.id, version: scripts.version })
      .from(scripts)
      .where(eq(scripts.episodeId, episode.id))
      .orderBy(asc(scripts.version));

    return {
      episode,
      scriptVersion: {
        id: created.id,
        episodeId: episode.id,
        version: nextVersion,
        content: JSON.stringify(script, null, 2),
      },
      versions,
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
   * Finds the episode the generated script belongs to, in priority order:
   * the plan's anchored episodeId, then the episode recorded by a previous
   * generation. The candidate is verified to exist within the plan's project
   * (404 otherwise), so a wrong project/episode/plan relationship can never
   * pass. Returns `null` when the plan references no episode at all — the
   * caller then creates one.
   */
  private async findReferencedEpisode(
    db: DbLike,
    projectId: string,
    plan: { episodeId: string | null; plan: unknown },
  ): Promise<ScriptGenerationResult["episode"] | null> {
    const planPayload = isPlainObject(plan.plan) ? plan.plan : null;
    const recordedEpisodeId =
      planPayload && typeof planPayload.episodeId === "string" ? planPayload.episodeId : null;

    const episodeId =
      typeof plan.episodeId === "string" ? plan.episodeId : recordedEpisodeId;
    if (!episodeId) return null;

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
      throw new ScriptGenerationError(
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
   * Creates a new episode for an unanchored plan. The episode number is the
   * next free slot in the project; the title comes from the story.
   */
  private async createEpisodeForPlan(
    db: DbLike,
    projectId: string,
    storyTitle: string | null,
  ): Promise<ScriptGenerationResult["episode"]> {
    const existingRows = (await db.select().from(episodes)) as unknown as Array<
      Record<string, unknown>
    >;
    const projectNumbers = existingRows
      .filter((row) => row.projectId === projectId)
      .map((row) => (typeof row.episodeNumber === "number" ? row.episodeNumber : 0));
    const episodeNumber = projectNumbers.length > 0 ? Math.max(...projectNumbers) + 1 : 1;

    const title = storyTitle ?? "Untitled episode";
    const [inserted] = await getDb()
      .insert(episodes)
      .values({
        projectId,
        title,
        episodeNumber,
        status: "draft",
      })
      .$returningId();
    if (!inserted) {
      throw new ScriptGenerationError("Failed to create the episode for the script", 502);
    }
    return {
      id: inserted.id,
      projectId,
      title,
      episodeNumber,
      status: "draft",
    };
  }

  /** Highest script version on an episode, or 0 when it has none. */
  private async maxScriptVersion(db: DbLike, episodeId: string): Promise<number> {
    const rows = (await getDb()
      .select({ version: scripts.version })
      .from(scripts)
      .where(eq(scripts.episodeId, episodeId))) as unknown as Array<{ version: unknown }>;
    let max = 0;
    for (const row of rows) {
      if (typeof row.version === "number" && Number.isFinite(row.version) && row.version > max) {
        max = row.version;
      }
    }
    return max;
  }

  /**
   * Merges the episode/script-version references into the plan payload,
   * preserving every unrelated key — including the story and any pre-existing
   * episodeId anchor. Only the planning-reference keys are written.
   */
  private withScriptReferences(
    plan: unknown,
    episodeId: string,
    scriptVersionId: string,
  ): Record<string, unknown> {
    const base = isPlainObject(plan) ? plan : {};
    return { ...base, episodeId, scriptVersionId };
  }
}

export const scriptGenerationService = new ScriptGenerationService();
