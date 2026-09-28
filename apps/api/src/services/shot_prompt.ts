/**
 * Shot prompt construction (C7.5).
 *
 * Builds the system + user prompt pair sent to the generic text provider for
 * shot generation, exactly like the C7.2–C7.4 builders: all knowledge of
 * "how to ask for shots" lives here, the generation service stays
 * provider-agnostic, and the resulting prompt is pure data for tests.
 *
 * Layer discipline (C7.5 vs earlier phases): the prompt produces SHOTS for
 * ONE already-decided scene — camera work, visual/action description,
 * transition, duration. It must not rewrite the script's dialogue, add or
 * remove scenes (the scene list is already fixed), produce media-generation
 * prompts, or assign ids/order indexes; those belong to the service or to
 * later phases (media generation owns `shots.prompt`).
 */

import type { ScriptContract, StoryContract } from "@icooro/shared";

/**
 * The resolved scene as the prompt sees it. Typed loosely on purpose: the
 * scene may have been created manually (nullable description), so the strict
 * C7.4 scene contract is NOT applied here — the shot layer adapts to reality.
 */
export interface ShotPromptSceneContext {
  name: string;
  description: string | null;
}

/** The slice of the C7.1 production-plan row the prompt actually needs. */
export interface ShotPromptPlanContext {
  request: string;
  targetDurationSeconds: number | null;
  preferences: unknown;
}

export interface ShotPromptContext {
  plan: ShotPromptPlanContext;
  story: StoryContract;
  script: ScriptContract;
  /** The resolved scene whose beats are broken into shots. */
  scene: ShotPromptSceneContext;
}

export interface BuiltShotPrompt {
  systemPrompt: string;
  userPrompt: string;
}

const SHOT_CONTRACT_EXAMPLE = `{
  "shots": [
    {
      "purpose": "string (what this shot is for, max 100 characters)",
      "shotType": "string (e.g. wide, medium, close-up; max 100 characters)",
      "framing": "string (e.g. full shot, two shot; max 100 characters)",
      "cameraMovement": "string (e.g. static, pan, tilt; max 100 characters)",
      "cameraAngle": "string (e.g. eye level, low angle; max 100 characters)",
      "actionDescription": "string (what happens in the shot, max 2000 characters)",
      "visualDescription": "string (what the shot looks like, max 2000 characters)",
      "transition": "string (how this shot hands off to the next, max 100 characters)",
      "duration": 8
    }
  ]
}`;

const SYSTEM_PROMPT = [
  "You are a shot planning assistant for an educational video production platform.",
  "You break ONE already-decided scene into a short ordered list of shots; they are planning artifacts, not media-generation prompts.",
  "Faithfully reflect the supplied story, script, and scene: preserve the characters, setting, learning objective, and narrative continuity.",
  "Do not add story or educational content that the supplied story, script, and scene do not support.",
  "Do NOT rewrite, reword, or extend any dialogue: the script's dialogue is final and must be reflected, not changed.",
  "Do NOT restructure the scene: produce shots for this scene only — no new scenes, no removed scenes, no reordered story.",
  "Produce between 1 and 10 shots, in narrative order, covering the whole scene.",
  "Create ONLY the shot layer: camera work, visual and action descriptions, transition, and duration.",
  "Do NOT include media-generation prompts, image or video prompt text, or any instructions for downstream media tools.",
  "Do NOT assign shot ids or order indexes; they are assigned by the service.",
  "Respond with EXACTLY one JSON object matching the requested keys — valid JSON only.",
  "Do NOT wrap the JSON in markdown code fences.",
  "Do NOT add any explanation, commentary, or prose outside the JSON object.",
].join(" ");

/**
 * Build the system + user prompt for generating a structured shot list for
 * the given scene, from the plan's validated story and script.
 */
export function buildShotPrompt(context: ShotPromptContext): BuiltShotPrompt {
  const { plan, story, script, scene } = context;

  const lines: string[] = [
    `Original request from the creator: "${plan.request}"`,
    "",
    "Story to stay faithful to (premise, characters, setting, learning objective):",
    JSON.stringify(story, null, 2),
    "",
    "Script the scene belongs to (its dialogue is final — reflect it, do not rewrite it):",
    JSON.stringify(script, null, 2),
    "",
    "Scene to break into shots (shots for THIS scene only):",
    JSON.stringify(scene, null, 2),
  ];

  if (plan.targetDurationSeconds != null) {
    lines.push(
      `Target duration: about ${plan.targetDurationSeconds} seconds for the WHOLE episode — keep the shots of this scene sized to their share of it.`,
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
    `Break this scene into shots as one JSON object with exactly this shape: ${SHOT_CONTRACT_EXAMPLE}.`,
  );

  return { systemPrompt: SYSTEM_PROMPT, userPrompt: lines.join("\n") };
}
