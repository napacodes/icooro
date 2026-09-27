import { eq } from "drizzle-orm";
import { storyContractSchema, type StoryContract } from "@icooro/shared";
import {
  findAdaptersForCapability,
  type AdapterCandidate,
  type DbLike,
} from "../providers/capabilities.js";
import { ProviderError, type TextProvider } from "../providers/types.js";
import { productionPlanService } from "./production_plan.js";
import { buildStoryPrompt } from "./story_prompt.js";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import { productionPlans } from "../db/schema/production_plans.js";

/**
 * Story generation (C7.2): the first AI-assisted Production Director step.
 *
 * ProductionPlan → Story Generator (generic text provider) → structured story
 * → ProductionPlan.plan.story
 *
 * Integration rules:
 * - The service depends ONLY on the C6.7/C6.8 provider abstraction
 *   (`findAdaptersForCapability` routing + the generic `TextProvider`
 *   interface). It never names a specific provider (OpenAI/Gemini/ChatFire)
 *   and performs no provider-specific request or response handling.
 * - Generation is planning-time and synchronous: no media GenerationJob, no
 *   background worker, no video-generation lifecycle code.
 * - The validated story is stored inside the existing `plan` JSON payload
 *   under the `story` key. Unrelated payload keys are preserved; a
 *   regeneration replaces only the story portion.
 * - A failed generation throws BEFORE any write, so an existing story (and
 *   all other plan data) survives a failed regeneration untouched.
 */

/** The only plan status from which story generation may run (planning-time AI). */
const GENERATION_ALLOWED_STATUS = "planning";

export class StoryGenerationError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(message: string, status: 400 | 404 | 409 | 502 = 502) {
    super(message);
    this.name = "StoryGenerationError";
    this.status = status;
  }
}

/**
 * Extract the first JSON object from model text. Tolerates markdown code
 * fences and stray prose around the object — the system prompt forbids both,
 * but models drift. Returns a plain (non-array) object or throws.
 */
export function extractJsonObject(text: string): unknown {
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

  throw new StoryGenerationError(
    "The AI response did not contain a valid JSON object.",
    502,
  );
}

/**
 * Parse and validate raw model output against the shared story contract.
 * This is the only path a model response takes into the plan payload: the
 * validated (and unknown-key-stripped) story object is what gets persisted.
 */
export function parseStoryResponse(rawText: string): StoryContract {
  const parsed = extractJsonObject(rawText);
  const result = storyContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new StoryGenerationError(
      "The AI response did not match the required story structure.",
      502,
    );
  }
  return result.data;
}

export interface StoryGenerationInput {
  projectId: string;
  productionPlanId: string;
}

export interface StoryGenerationResult {
  /** The full next plan payload (`story` merged into the existing payload). */
  plan: Record<string, unknown>;
  /** The validated story that was persisted under `plan.story`. */
  story: StoryContract;
}

/**
 * Deterministic model choice, mirroring the C6.8.2 routing rule (earliest
 * createdAt wins). Rows with an unparsable/missing timestamp sort last so a
 * broken row can never silently win.
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

export class StoryGenerationService {
  /**
   * Generates (or regenerates) a structured story for the plan and persists
   * it into the plan payload. Planning-time only: allowed solely while the
   * plan is in `planning` status. Ownership (project + plan/project
   * relationship) is enforced by the caller: the route checks project
   * ownership C7.1-style, and the plan lookup below is scoped to the
   * project, so a plan from another project is a 404 by construction.
   */
  async generateStory(input: StoryGenerationInput): Promise<StoryGenerationResult> {
    const db: DbLike = getDb();

    // 1. Load the plan scoped to its project. A plan from another project is
    //    indistinguishable from a missing one (404, never 403).
    const existing = await productionPlanService.getPlan(
      input.productionPlanId,
      input.projectId,
    );
    if (!existing) {
      throw new StoryGenerationError("Production plan not found", 404);
    }

    // 2. State gate: story generation is planning-time only.
    if (existing.status !== GENERATION_ALLOWED_STATUS) {
      throw new StoryGenerationError(
        `Story can only be generated while the production plan is in "${GENERATION_ALLOWED_STATUS}" status (current status: "${existing.status}")`,
        409,
      );
    }

    // 3. Prompt construction (dedicated builder; request + context only).
    //    (No .limit(1): the id lookup yields at most one row.)
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const projectName = typeof project?.name === "string" ? project.name : null;
    const builtPrompt = buildStoryPrompt({
      plan: {
        request: existing.request,
        episodeId: existing.episodeId,
        targetDurationSeconds: existing.targetDurationSeconds,
        preferences: existing.preferences,
      },
      projectName,
    });

    // 4. Model selection through the existing C6.8 capability routing —
    //    capability "text", adapter-constructible candidates only. No
    //    provider type is named anywhere in this service.
    const candidates = await findAdaptersForCapability({ db, capability: "text" });
    if (candidates.length === 0) {
      throw new StoryGenerationError(
        "No enabled text model is configured for story generation.",
        400,
      );
    }
    const chosen = [...candidates].sort(compareByCreatedAt)[0];
    if (!chosen) {
      throw new StoryGenerationError(
        "No enabled text model is configured for story generation.",
        400,
      );
    }

    // 5. Generic text generation via the TextProvider interface — no
    //    provider-specific code, ever. Capability routing only returns
    //    candidates whose adapter supports the requested capability, so the
    //    text surface assertion below always holds for routed candidates.
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
        throw new StoryGenerationError(`Story generation failed: ${err.message}`, 502);
      }
      throw new StoryGenerationError(
        "Story generation failed due to an unexpected provider error.",
        502,
      );
    }

    // 6. Parse + Zod-validate the model output against the shared contract.
    //    A response that fails here throws before any write.
    const story = parseStoryResponse(rawText);

    // 7. Persist ONLY the story portion: merge `story` into the existing
    //    plan payload, preserving every unrelated key. A payload-less plan
    //    gets `{ story }`.
    const base =
      existing.plan !== null &&
      typeof existing.plan === "object" &&
      !Array.isArray(existing.plan)
        ? (existing.plan as Record<string, unknown>)
        : {};
    const nextPlan: Record<string, unknown> = { ...base, story };

    try {
      await getDb()
        .update(productionPlans)
        .set({ plan: nextPlan })
        .where(eq(productionPlans.id, input.productionPlanId));
    } catch (err) {
      throw new Error("Failed to persist the generated story", { cause: err });
    }

    return { plan: nextPlan, story };
  }
}

export const storyGenerationService = new StoryGenerationService();
