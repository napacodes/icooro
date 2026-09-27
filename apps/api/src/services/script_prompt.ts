/**
 * Script prompt construction (C7.3).
 *
 * Builds the system + user prompt pair sent to the generic text provider for
 * script generation, exactly like the C7.2 story builder: all knowledge of
 * "how to ask for a script" lives here, the generation service stays
 * provider-agnostic, and the resulting prompt is pure data for tests.
 *
 * Layer discipline (C7.3 vs C7.4/C7.5): the prompt produces the SCRIPT —
 * title, objective, dialogue, closing line. It must not produce scenes,
 * camera or shot instructions; those belong to later phases.
 */

import type { StoryContract } from "@icooro/shared";

/** The slice of the C7.1 production-plan row the prompt actually needs. */
export interface ScriptPromptPlanContext {
  request: string;
  targetDurationSeconds: number | null;
  preferences: unknown;
}

export interface ScriptPromptContext {
  plan: ScriptPromptPlanContext;
  story: StoryContract;
  projectName: string | null;
}

export interface BuiltScriptPrompt {
  systemPrompt: string;
  userPrompt: string;
}

const SCRIPT_CONTRACT_EXAMPLE = `{
  "title": "string (episode title; may reuse the story title)",
  "objective": "string (the learning objective this script serves, carried over from the story)",
  "estimatedDurationSeconds": 30,
  "dialogue": [{ "speaker": "string", "text": "string (one concise spoken line)" }],
  "closingLine": { "speaker": "string", "text": "string (the line that closes the episode and reinforces the objective)" }
}`;

const SYSTEM_PROMPT = [
  "You are a script planning assistant for an educational video production platform.",
  "You turn approved story outlines into episode scripts; they are planning artifacts, not shooting scripts.",
  "Preserve the story's premise exactly and serve its learning objective.",
  "Respect the requested target duration: keep the script short enough to fit it.",
  "If the audience is children (or the tone implies it), all dialogue must be age-appropriate, gentle, and positive.",
  "Keep every line of dialogue concise and identify the speaker clearly.",
  "Do not introduce characters that are not in the story.",
  "Create ONLY the script layer: do NOT include scenes, camera directions, shot lists, or any scene/shot planning.",
  "Respond with EXACTLY one JSON object matching the requested keys — valid JSON only.",
  "Do NOT wrap the JSON in markdown code fences.",
  "Do NOT add any explanation, commentary, or prose outside the JSON object.",
].join(" ");

/**
 * Build the system + user prompt for generating a structured script from the
 * plan's story.
 */
export function buildScriptPrompt(context: ScriptPromptContext): BuiltScriptPrompt {
  const { plan, story, projectName } = context;

  const lines: string[] = [
    `Project: ${projectName ?? "unnamed project"}.`,
    `Original request from the creator: "${plan.request}"`,
    "",
    "Story to adapt (preserve its premise and learning objective):",
    JSON.stringify(story, null, 2),
  ];

  if (plan.targetDurationSeconds != null) {
    lines.push(
      `Target duration: about ${plan.targetDurationSeconds} seconds — keep the script tight enough to fit.`,
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
    `Write the script for this story as one JSON object with exactly these keys: ${SCRIPT_CONTRACT_EXAMPLE}.`,
  );

  return { systemPrompt: SYSTEM_PROMPT, userPrompt: lines.join("\n") };
}
