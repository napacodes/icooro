import { and, eq, isNull } from "drizzle-orm";
import {
  scriptContractSchema,
  shotPromptContractSchema,
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
import {
  buildMediaPrompt,
  type MediaPromptSceneContext,
  type MediaPromptShotContext,
} from "./media_prompt.js";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import { episodes } from "../db/schema/episodes.js";
import { scripts } from "../db/schema/scripts.js";
import { scenes } from "../db/schema/scenes.js";
import { shots } from "../db/schema/shots.js";
import { productionPlans } from "../db/schema/production_plans.js";

/**
 * Media prompt generation (C7.6): the fifth AI-assisted Production Director
 * step.
 *
 * ProductionPlan → validated Story + Script + Scene + Shot → Prompt
 * Generator (generic text provider) → ONE media prompt → the shot's
 * EXISTING `shots.prompt` column
 *
 * Orchestration, not duplication: the generated prompt lands in the same
 * field the manual generation workflow (C6 jobs) and the UI already read.
 * NO `shot_versions` or `ai_jobs` writes — job creation remains the manual
 * C6 flow (and later C7.7 orchestration); shot_versions stays media
 * lineage. The plan records only AI authorship: `plan.promptedShotIds`
 * (flat string array of shot ids whose prompt was AI-authored), merged
 * over the existing payload so every unrelated key (story, episodeId,
 * scriptVersionId, sceneIds, shotIds, user keys) survives.
 *
 * Approved manual-work preservation rule: a shot whose `prompt` is already
 * set and that is NOT tracked in `promptedShotIds` was authored by hand —
 * generation returns 409 rather than silently overwriting it. The user
 * clears the field to hand the shot to AI. A tracked shot may always be
 * regenerated (overwrite its AI-authored prompt).
 *
 * Integration rules (same as C7.2–C7.5):
 * - The service depends ONLY on the C6.7/C6.8 provider abstraction
 *   (`findAdaptersForCapability` routing + the generic `TextProvider`
 *   interface). It never names a specific provider (OpenAI/Gemini/ChatFire)
 *   and performs no provider-specific request or response handling.
 * - Generation is planning-time and synchronous: no media GenerationJob,
 *   no background worker, no invented text job type, no `ai_jobs` row.
 * - A story, a script, a scene of the resolved episode, and a shot of that
 *   scene are ALL REQUIRED.
 * - Every prerequisite (including the manual-preservation gate) runs
 *   BEFORE any provider call or write, so a failed generation writes
 *   nothing.
 * - KNOWN LIMITATION (non-transactional, repo-wide convention): the shot
 *   prompt update and the plan tracking update are two separate writes.
 *   If the plan update fails after the prompt was written, the prompt is
 *   correct but untracked — the next generation attempt then sees a
 *   non-null untracked prompt and returns 409 (manual-preservation rule).
 *   Recovery is explicit and safe: the user clears `shots.prompt` and
 *   retries, or accepts the prompt as hand-authored. Same documented
 *   posture as C7.3–C7.5; no transactionality is claimed or implemented.
 */

/** The only plan status from which prompt generation may run (planning-time AI). */
const GENERATION_ALLOWED_STATUS = "planning";

export class PromptGenerationError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(message: string, status: 400 | 404 | 409 | 502 = 502) {
    super(message);
    this.name = "PromptGenerationError";
    this.status = status;
  }
}

/**
 * Extract the first JSON object from model text (tolerating fences and
 * stray prose). Same parsing contract as C7.2–C7.5's generators.
 */
export function extractPromptJsonObject(text: string): unknown {
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

  throw new PromptGenerationError(
    "The AI response did not contain a valid JSON object.",
    502,
  );
}

/**
 * Parse and validate raw model output against the shared shot-prompt
 * contract. The validated (unknown-key-stripped) prompt is the only thing
 * that ever reaches `shots.prompt`.
 */
export function parsePromptResponse(rawText: string): string {
  const parsed = extractPromptJsonObject(rawText);
  const result = shotPromptContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new PromptGenerationError(
      "The AI response did not match the required prompt structure.",
      502,
    );
  }
  return result.data.prompt;
}

export interface PromptGenerationInput {
  projectId: string;
  productionPlanId: string;
  sceneId: string;
  shotId: string;
}

export interface PromptGenerationResult {
  /** The shot whose prompt was written. */
  shot: { id: string; sceneId: string; prompt: string };
  /** The script version the prompt was derived from. */
  scriptVersion: { id: string; version: number };
  /** The updated plan payload (`promptedShotIds` merged, all other keys preserved). */
  plan: Record<string, unknown>;
}

/**
 * Deterministic model choice — identical rule to C7.2–C7.5's generators
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

export class PromptGenerationService {
  /**
   * Generates (or regenerates) the media prompt for ONE shot from the
   * plan's story and script and writes it into the shot's existing
   * `shots.prompt` column. Planning-time only: allowed solely while the
   * plan is in `planning` status. Ownership is enforced by the caller: the
   * route checks project ownership C7.1-style, and every lookup below is
   * scoped to the project via the plan → episode → scene → shot chain.
   */
  async generateShotPrompt(input: PromptGenerationInput): Promise<PromptGenerationResult> {
    const db: DbLike = getDb();

    // 1. Load the plan scoped to its project (404 for foreign/missing plans).
    const existing = await productionPlanService.getPlan(
      input.productionPlanId,
      input.projectId,
    );
    if (!existing) {
      throw new PromptGenerationError("Production plan not found", 404);
    }

    // 2. State gate: prompt generation is planning-time only.
    if (existing.status !== GENERATION_ALLOWED_STATUS) {
      throw new PromptGenerationError(
        `Prompts can only be generated while the production plan is in "${GENERATION_ALLOWED_STATUS}" status (current status: "${existing.status}")`,
        409,
      );
    }

    // 3. Story REQUIRED: re-validated from the payload (user-editable).
    const story = this.extractStoryFromPlan(existing.plan);
    if (!story) {
      throw new PromptGenerationError(
        "No story has been generated for this production plan yet. Generate a story first (C7.2) before generating prompts.",
        400,
      );
    }

    // 4. Episode relationship precondition: C7.3–C7.5 precedence (plan row's
    //    episodeId, then the payload's episodeId), verified within the
    //    project BEFORE any provider work.
    const episode = await this.findReferencedEpisode(db, input.projectId, existing);

    // 5. Target scene: must exist AND belong to the resolved episode — a
    //    cross-episode or cross-project scene is an indistinguishable 404.
    const scene = await this.findTargetScene(db, episode.id, input.sceneId);

    // 6. Script REQUIRED: C7.5's resolve + revalidate semantics, BEFORE any
    //    provider call.
    const script = await this.resolveScript(db, episode.id, existing.plan);

    // 7. Target shot: must exist AND belong to the resolved scene — a
    //    cross-scene, cross-episode, or cross-project shot is an
    //    indistinguishable 404.
    const shot = await this.findTargetShot(db, input.sceneId, input.shotId);

    // 8. Manual-work preservation (approved rule): a non-null prompt on an
    //    UNTRACKED shot is hand-authored — never silently overwritten.
    const trackedIds = this.extractTrackedPromptedShotIds(existing.plan);
    const isTracked = trackedIds.includes(input.shotId);
    if (shot.prompt !== null && !isTracked) {
      throw new PromptGenerationError(
        "This shot already has a manually authored prompt. Clear the prompt field first if you want AI to generate a new one.",
        409,
      );
    }

    // 9. Prompt construction (dedicated builder; request + story + script +
    //    scene + shot context). All persistence happens strictly after
    //    output validation, so every failure path so far has written
    //    nothing.
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const projectName = typeof project?.name === "string" ? project.name : null;
    const sceneContext: MediaPromptSceneContext = {
      name: scene.name,
      description: scene.description ?? null,
    };
    const shotContext: MediaPromptShotContext = {
      purpose: shot.purpose,
      shotType: shot.shotType,
      framing: shot.framing,
      cameraMovement: shot.cameraMovement,
      cameraAngle: shot.cameraAngle,
      actionDescription: shot.actionDescription,
      visualDescription: shot.visualDescription,
      transition: shot.transition,
      duration: shot.duration,
      dialogue: shot.dialogue,
    };
    const builtPrompt = buildMediaPrompt({
      plan: {
        request: existing.request,
        targetDurationSeconds: existing.targetDurationSeconds,
        preferences: existing.preferences,
      },
      story,
      script,
      scene: sceneContext,
      shot: shotContext,
    });

    // 10. Model selection through the existing C6.8 capability routing —
    //     capability "text", adapter-constructible candidates only.
    const candidates = await findAdaptersForCapability({ db, capability: "text" });
    if (candidates.length === 0) {
      throw new PromptGenerationError(
        "No enabled text model is configured for prompt generation.",
        400,
      );
    }
    const chosen = [...candidates].sort(compareByCreatedAt)[0];
    if (!chosen) {
      throw new PromptGenerationError(
        "No enabled text model is configured for prompt generation.",
        400,
      );
    }

    // 11. Generic text generation via the TextProvider interface — no
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
        throw new PromptGenerationError(`Prompt generation failed: ${err.message}`, 502);
      }
      throw new PromptGenerationError(
        "Prompt generation failed due to an unexpected provider error.",
        502,
      );
    }

    // 12. Parse + Zod-validate the model output against the shared contract.
    //     A response that fails here throws before any write.
    const generatedPrompt = parsePromptResponse(rawText);

    // 13. Persist with manual-edit protection (the mid-flight race the
    //     pre-provider gate in step 8 cannot cover): a user may edit the
    //     shot's prompt WHILE the provider is generating. The prompt is
    //     therefore written only when the current value still matches the
    //     snapshot read in step 7, enforced in two layers:
    //       a) re-read + compare immediately before the write (deterministic,
    //          exercised by the race regression test);
    //       b) an atomic conditional UPDATE (`prompt IS NULL` for a null
    //          snapshot, `prompt = snapshot` otherwise) so the residual
    //          window is closed at the database, exactly like the layered
    //          guard in completeJobWithAssetVersion.
    //     On any mismatch the generation aborts with a 409 BEFORE either
    //     write: the manual edit survives untouched and nothing is tracked.
    //     NO shot_versions and NO ai_jobs writes. The prompt update and the
    //     plan tracking update remain non-transactional (see the documented
    //     limitation in the header): if the plan update fails after the
    //     prompt was written, the prompt is correct but untracked and the
    //     next attempt returns 409 until the user clears the field —
    //     explicit, safe recovery.
    const persisted = await this.persistShotPromptGuarded(
      db,
      input.shotId,
      shot.prompt,
      generatedPrompt,
    );
    if (!persisted) {
      throw new PromptGenerationError(
        "The shot's prompt was edited while the media prompt was being generated; the manual edit was preserved and nothing was overwritten. Retry if you still want AI to replace it.",
        409,
      );
    }

    const nextPlan = this.withPromptTracking(existing.plan, input.shotId);

    try {
      await getDb()
        .update(productionPlans)
        .set({ plan: nextPlan })
        .where(eq(productionPlans.id, input.productionPlanId));
    } catch (err) {
      throw new Error("Failed to record the prompt tracking on the production plan", {
        cause: err,
      });
    }

    return {
      shot: { id: input.shotId, sceneId: input.sceneId, prompt: generatedPrompt },
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
   * Extracts the AI-prompted shot ids from the plan payload's flat
   * `promptedShotIds` key. Anything that is not a non-empty string is
   * ignored, so a corrupted list can never turn into a destructive
   * wildcard.
   */
  extractTrackedPromptedShotIds(plan: unknown): string[] {
    if (!isPlainObject(plan)) return [];
    const raw = plan.promptedShotIds;
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  /**
   * Merges AI authorship for `shotId` into the plan payload's flat
   * `promptedShotIds` list, preserving every unrelated key — including the
   * story, episode/script/scene/shot references, other prompted shots, and
   * any user payload keys. Idempotent: a tracked id keeps its position.
   */
  private withPromptTracking(plan: unknown, shotId: string): Record<string, unknown> {
    const base = isPlainObject(plan) ? plan : {};
    const tracked = this.extractTrackedPromptedShotIds(plan);
    const next = tracked.includes(shotId) ? tracked : [...tracked, shotId];
    return { ...base, promptedShotIds: next };
  }

  /**
   * Writes the generated prompt into `shots.prompt` only while the stored
   * value still equals the snapshot taken when the shot was resolved — the
   * manual-edit protection for a prompt edited while generation was in
   * flight (the pre-provider gate alone cannot cover that window). Two
   * layers:
   *   a) an immediate re-read + comparison (deterministic, and the layer
   *      the fake DB in tests exercises);
   *   b) an atomic conditional UPDATE guarded on the snapshotted value
   *      (`prompt IS NULL` when the snapshot was null, `prompt = snapshot`
   *      otherwise), closing the residual re-read→write window at the
   *      database the same way `completeJobWithAssetVersion` guards its
   *      job link.
   * Returns false when the shot's prompt changed in the meantime; the
   * caller then aborts with a 409 and NOTHING has been written.
   */
  private async persistShotPromptGuarded(
    db: DbLike,
    shotId: string,
    snapshotPrompt: string | null,
    generatedPrompt: string,
  ): Promise<boolean> {
    // (a) Re-read and compare.
    const rows = await db
      .select({ prompt: shots.prompt })
      .from(shots)
      .where(eq(shots.id, shotId));
    const current = rows[0];
    const currentPrompt =
      current && typeof current.prompt === "string" ? current.prompt : null;
    if (currentPrompt !== snapshotPrompt) return false;

    // (b) Atomic conditional write: succeeds only if the value still
    //     matches the snapshot. No .limit(1); the id predicate yields at
    //     most one row.
    const condition =
      snapshotPrompt === null
        ? and(eq(shots.id, shotId), isNull(shots.prompt))
        : and(eq(shots.id, shotId), eq(shots.prompt, snapshotPrompt));
    const result = await getDb()
      .update(shots)
      .set({ prompt: generatedPrompt })
      .where(condition);
    const affected = (result as unknown as { affectedRows?: number }).affectedRows;
    return typeof affected === "number" ? affected > 0 : true;
  }

  /**
   * Finds the episode the prompt belongs to, in priority order: the plan's
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
      throw new PromptGenerationError(
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
      throw new PromptGenerationError(
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
      throw new PromptGenerationError(
        "The scene was not found in the episode associated with this production plan",
        404,
      );
    }
    return { id: row.id, episodeId: row.episodeId, name: row.name, description: row.description };
  }

  /**
   * Resolves and revalidates the script the media prompt must be derived
   * from. Identical semantics to C7.5's shot generator: the explicitly
   * referenced `plan.scriptVersionId` must exist AND belong to the resolved
   * episode (404 otherwise, never silently replaced), else the highest
   * script version on the episode is used (none → 400). Stored content is
   * parsed and revalidated against the shared contract; manual content is
   * not automatically trusted. Invalid content is a 400 with no fallback.
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
        throw new PromptGenerationError(
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
        throw new PromptGenerationError(
          "No script has been generated for this episode yet. Generate a script first (C7.3) before generating prompts.",
          400,
        );
      }
      scriptRow = best;
    }

    const parsed = this.parseScriptContent(scriptRow.content);
    if (!parsed) {
      throw new PromptGenerationError(
        "The script for this episode is not a valid script document. Generate a valid script (C7.3) before generating prompts.",
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
   * Resolves the target shot: it must exist AND belong to the resolved
   * scene. A shot of another scene (or another episode/project) is an
   * indistinguishable 404 — no cross-tenant information is disclosed.
   */
  private async findTargetShot(
    db: DbLike,
    sceneId: string,
    shotId: string,
  ): Promise<
    MediaPromptShotContext & {
      id: string;
      sceneId: string;
      prompt: string | null;
    }
  > {
    const rows = await db
      .select({
        id: shots.id,
        sceneId: shots.sceneId,
        prompt: shots.prompt,
        purpose: shots.purpose,
        shotType: shots.shotType,
        framing: shots.framing,
        cameraMovement: shots.cameraMovement,
        cameraAngle: shots.cameraAngle,
        actionDescription: shots.actionDescription,
        visualDescription: shots.visualDescription,
        transition: shots.transition,
        duration: shots.duration,
        dialogue: shots.dialogue,
      })
      .from(shots)
      .where(and(eq(shots.id, shotId), eq(shots.sceneId, sceneId)));
    const row = rows[0];
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.sceneId !== "string" ||
      (row.prompt !== null && typeof row.prompt !== "string") ||
      (row.purpose !== null && typeof row.purpose !== "string") ||
      (row.shotType !== null && typeof row.shotType !== "string") ||
      (row.framing !== null && typeof row.framing !== "string") ||
      (row.cameraMovement !== null && typeof row.cameraMovement !== "string") ||
      (row.cameraAngle !== null && typeof row.cameraAngle !== "string") ||
      (row.actionDescription !== null && typeof row.actionDescription !== "string") ||
      (row.visualDescription !== null && typeof row.visualDescription !== "string") ||
      (row.transition !== null && typeof row.transition !== "string") ||
      (row.duration !== null && typeof row.duration !== "number") ||
      (row.dialogue !== null && typeof row.dialogue !== "string")
    ) {
      throw new PromptGenerationError(
        "The shot was not found in the scene associated with this production plan",
        404,
      );
    }
    return {
      id: row.id,
      sceneId: row.sceneId,
      prompt: row.prompt,
      purpose: row.purpose,
      shotType: row.shotType,
      framing: row.framing,
      cameraMovement: row.cameraMovement,
      cameraAngle: row.cameraAngle,
      actionDescription: row.actionDescription,
      visualDescription: row.visualDescription,
      transition: row.transition,
      duration: row.duration,
      dialogue: row.dialogue,
    };
  }
}

export const promptGenerationService = new PromptGenerationService();
