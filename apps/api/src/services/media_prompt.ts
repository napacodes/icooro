/**
 * Media prompt construction (C7.6).
 *
 * Builds the system + user prompt pair sent to the generic text provider to
 * generate the media prompt for ONE existing shot, exactly like the
 * C7.2–C7.5 builders: all knowledge of "how to ask for a media prompt"
 * lives here, the generation service stays provider-agnostic, and the
 * resulting prompt is pure data for tests.
 *
 * Layer discipline (C7.6 vs earlier phases): the output is ONE media prompt
 * for THIS shot — a concrete, visual, media-model-ready description. It
 * must not add story or educational content the supplied context does not
 * support, must not describe or invent other shots, and must not include
 * ids or order indexes. `shots.prompt` is media-generation territory: the
 * dialogue, character, and setting context is read-only reference for
 * visual continuity, never something the media prompt rewrites.
 */

import type { ScriptContract, StoryContract } from "@icooro/shared";

/**
 * The target shot as the prompt sees it. The shot's `dialogue` is included
 * as read-only reference (visual continuity), never as something to extend.
 */
export interface MediaPromptShotContext {
  purpose: string | null;
  shotType: string | null;
  framing: string | null;
  cameraMovement: string | null;
  cameraAngle: string | null;
  actionDescription: string | null;
  visualDescription: string | null;
  transition: string | null;
  duration: number | null;
  dialogue: string | null;
}

/**
 * The resolved scene as the prompt sees it. Typed loosely on purpose: the
 * scene may have been created manually (nullable description), so the
 * strict C7.4 scene contract is NOT applied here.
 */
export interface MediaPromptSceneContext {
  name: string;
  description: string | null;
}

/** The slice of the C7.1 production-plan row the prompt actually needs. */
export interface MediaPromptPlanContext {
  request: string;
  targetDurationSeconds: number | null;
  preferences: unknown;
}

export interface MediaPromptContext {
  plan: MediaPromptPlanContext;
  story: StoryContract;
  script: ScriptContract;
  scene: MediaPromptSceneContext;
  shot: MediaPromptShotContext;
}

export interface BuiltMediaPrompt {
  systemPrompt: string;
  userPrompt: string;
}

const SHOT_PROMPT_CONTRACT_EXAMPLE = `{
  "prompt": "string (the media-generation prompt for THIS shot, max 2000 characters)"
}`;

const SYSTEM_PROMPT = [
  "You are a media prompt assistant for an educational video production platform.",
  "You write ONE media-generation prompt describing a single already-planned shot, to be used with text-to-video or text-to-image media models.",
  "Faithfully reflect the supplied story, script, scene, and shot: preserve the characters, setting, learning objective, and visual continuity.",
  "Do not add story or educational content that the supplied story, script, scene, and shot do not support.",
  "Describe ONLY this shot: do not describe, summarize, or invent other shots, scenes, or story beats.",
  "Keep the dialogue final: it is supplied as read-only reference for visual continuity — do NOT rewrite, extend, or add dialogue.",
  "Produce concrete visual language suitable for a media model: subject, action, setting, composition, mood.",
  "Do NOT include identifiers, order indexes, technical parameters, negative prompts, or instructions for downstream tools.",
  "Respond with EXACTLY one JSON object matching the requested keys — valid JSON only.",
  "Do NOT wrap the JSON in markdown code fences.",
  "Do NOT add any explanation, commentary, or prose outside the JSON object.",
].join(" ");

/**
 * Renders one labelled context line for a nullable shot/scene field,
 * omitting fields the shot does not have (manual shots may leave many
 * fields null).
 */
function fieldLine(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return `${label}: ${trimmed}`;
}

/**
 * Build the system + user prompt for generating the media prompt of the
 * given shot, from the plan's validated story and script.
 */
export function buildMediaPrompt(context: MediaPromptContext): BuiltMediaPrompt {
  const { plan, story, script, scene, shot } = context;

  const lines: string[] = [
    `Original request from the creator: "${plan.request}"`,
    "",
    "Story context (premise, characters, setting, learning objective):",
    JSON.stringify(story, null, 2),
    "",
    "Script context (dialogue is final read-only reference for visual continuity):",
    JSON.stringify(script, null, 2),
    "",
    "Scene this shot belongs to:",
    JSON.stringify(scene, null, 2),
    "",
    "Shot to write the media prompt for:",
  ];

  const shotLines = [
    fieldLine("Purpose", shot.purpose),
    fieldLine("Shot type", shot.shotType),
    fieldLine("Framing", shot.framing),
    fieldLine("Camera movement", shot.cameraMovement),
    fieldLine("Camera angle", shot.cameraAngle),
    fieldLine("Action", shot.actionDescription),
    fieldLine("Visual", shot.visualDescription),
    fieldLine("Transition", shot.transition),
    shot.duration !== null && shot.duration !== undefined ? `Duration: ${shot.duration} seconds` : null,
    fieldLine("Dialogue in this shot (read-only reference, do not change it)", shot.dialogue),
  ].filter((line): line is string => line !== null);

  if (shotLines.length === 0) {
    lines.push("(The shot has no planned details yet; describe it from the scene and story context alone.)");
  } else {
    lines.push(...shotLines);
  }

  if (plan.targetDurationSeconds != null) {
    lines.push(
      `Target duration: about ${plan.targetDurationSeconds} seconds for the WHOLE episode — keep this shot's media prompt consistent with its share of it.`,
    );
  }

  if (
    plan.preferences !== null &&
    typeof plan.preferences === "object" &&
    Object.keys(plan.preferences as Record<string, unknown>).length > 0
  ) {
    lines.push(`Creator preferences: ${JSON.stringify(plan.preferences)}`);
  }

  lines.push(
    `Write the media prompt for this shot as one JSON object with exactly this shape: ${SHOT_PROMPT_CONTRACT_EXAMPLE}.`,
  );

  return { systemPrompt: SYSTEM_PROMPT, userPrompt: lines.join("\n") };
}
