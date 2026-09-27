/**
 * Story prompt construction (C7.2).
 *
 * Builds the system + user prompt pair sent to the generic text provider for
 * story generation. All knowledge of "how to ask for a story" lives here —
 * the generation service stays provider-agnostic and the resulting prompt is
 * pure data, so tests can assert on it deterministically.
 *
 * The builder is project-agnostic: it works for any project. Mozytoon (or any
 * other series) appears only through the plan request / project context, never
 * as hard-coded logic.
 */

/** The slice of the C7.1 production-plan row the prompt actually needs. */
export interface StoryPromptPlanContext {
  request: string;
  episodeId: string | null;
  targetDurationSeconds: number | null;
  preferences: unknown;
}

export interface StoryPromptContext {
  plan: StoryPromptPlanContext;
  projectName: string | null;
}

export interface BuiltStoryPrompt {
  systemPrompt: string;
  userPrompt: string;
}

const STORY_CONTRACT_EXAMPLE = `{
  "title": "string (short, kid-friendly if children are implied)",
  "premise": "string (one or two sentences describing the episode)",
  "learningObjective": "string (what the viewer should understand afterwards)",
  "characters": ["string", "..."],
  "setting": "string (where and when the story takes place)",
  "beginning": "string (how the story opens and sets up the objective)",
  "middle": "string (the main development or playful conflict)",
  "ending": "string (how it resolves and reinforces the objective)",
  "estimatedDurationSeconds": 30
}`;

const SYSTEM_PROMPT = [
  "You are a story planning assistant for an educational video production platform.",
  "You draft concise story outlines for planned episodes; they are planning artifacts, not scripts.",
  "Educational and story-planning intent takes priority: the story must clearly serve its learning objective.",
  "If the request is aimed at children (or the tone implies it), the story must be age-appropriate, gentle, and positive.",
  "Respond with EXACTLY one JSON object matching the requested keys — valid JSON only.",
  "Do NOT wrap the JSON in markdown code fences.",
  "Do NOT add any explanation, commentary, or prose outside the JSON object.",
].join(" ");

/**
 * Build the system + user prompt for generating a structured story for the
 * given production plan.
 */
export function buildStoryPrompt(context: StoryPromptContext): BuiltStoryPrompt {
  const { plan, projectName } = context;

  const lines: string[] = [
    `Project: ${projectName ?? "unnamed project"}.`,
    plan.episodeId
      ? "This story belongs to an existing episode of the project."
      : "This story is a standalone plan for a new episode.",
  ];

  if (plan.targetDurationSeconds != null) {
    lines.push(
      `Target duration: about ${plan.targetDurationSeconds} seconds — keep the story tight enough to fit.`,
    );
  }

  if (
    plan.preferences !== null &&
    typeof plan.preferences === "object" &&
    Object.keys(plan.preferences as Record<string, unknown>).length > 0
  ) {
    lines.push(`Creator preferences: ${JSON.stringify(plan.preferences)}`);
  }

  lines.push(`Original request from the creator: "${plan.request}"`);

  lines.push(
    `Draft a story for this request as one JSON object with exactly these keys: ${STORY_CONTRACT_EXAMPLE}.`,
  );

  return { systemPrompt: SYSTEM_PROMPT, userPrompt: lines.join("\n") };
}