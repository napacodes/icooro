/**
 * Scene prompt construction (C7.4).
 *
 * Builds the system + user prompt pair sent to the generic text provider for
 * scene generation, exactly like the C7.2/C7.3 builders: all knowledge of
 * "how to ask for scenes" lives here, the generation service stays
 * provider-agnostic, and the resulting prompt is pure data for tests.
 *
 * Layer discipline (C7.4 vs C7.3/C7.5): the prompt produces SCENES — names
 * and descriptions of episode beats. It must not produce shots, camera
 * directions, dialogue, or media-generation instructions; dialogue belongs
 * to the script layer (C7.3), shots to a later phase (C7.5).
 */

import type { ScriptContract, StoryContract } from "@icooro/shared";

/** The slice of the C7.1 production-plan row the prompt actually needs. */
export interface ScenePromptPlanContext {
  request: string;
  targetDurationSeconds: number | null;
  preferences: unknown;
}

export interface ScenePromptContext {
  plan: ScenePromptPlanContext;
  story: StoryContract;
  script: ScriptContract;
  projectName: string | null;
}

export interface BuiltScenePrompt {
  systemPrompt: string;
  userPrompt: string;
}

const SCENE_CONTRACT_EXAMPLE = `{
  "scenes": [
    { "name": "string (short scene name, max 255 characters)", "description": "string (what happens in this scene, max 2000 characters)" }
  ]
}`;

const SYSTEM_PROMPT = [
  "You are a scene planning assistant for an educational video production platform.",
  "You break approved episode scripts into scenes; they are planning artifacts, not shooting scripts.",
  "Faithfully reflect the supplied story and script: preserve the characters, setting, learning objective, and narrative continuity.",
  "Do not add story or educational content that the supplied story and script do not support.",
  "Produce between 1 and 20 scenes, in narrative order, covering the whole script.",
  "Create ONLY the scene layer: include ONLY scene names and descriptions.",
  "Do NOT include shots, camera directions, shot lists, dialogue, image or video prompts, or any media-generation instructions.",
  "Respond with EXACTLY one JSON object matching the requested keys — valid JSON only.",
  "Do NOT wrap the JSON in markdown code fences.",
  "Do NOT add any explanation, commentary, or prose outside the JSON object.",
].join(" ");

/**
 * Build the system + user prompt for generating a structured scene list from
 * the plan's validated story and script.
 */
export function buildScenePrompt(context: ScenePromptContext): BuiltScenePrompt {
  const { plan, story, script, projectName } = context;

  const lines: string[] = [
    `Project: ${projectName ?? "unnamed project"}.`,
    `Original request from the creator: "${plan.request}"`,
    "",
    "Story to stay faithful to (premise, characters, setting, learning objective):",
    JSON.stringify(story, null, 2),
    "",
    "Script to break into scenes (keep its narrative continuity; do not invent new dialogue here):",
    JSON.stringify(script, null, 2),
  ];

  if (plan.targetDurationSeconds != null) {
    lines.push(
      `Target duration: about ${plan.targetDurationSeconds} seconds — size the scene list so it can fit.`,
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
    `Break this script into scenes as one JSON object with exactly this shape: ${SCENE_CONTRACT_EXAMPLE}.`,
  );

  return { systemPrompt: SYSTEM_PROMPT, userPrompt: lines.join("\n") };
}
