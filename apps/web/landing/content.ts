/**
 * Landing page content (F1).
 *
 * All editable copy, links and accents for the public landing page live here,
 * typed by `./types.ts`. Components import `landingContent` and never hardcode
 * editorial text, so a later CMS phase can replace this module with a fetched
 * payload without touching the presentation layer.
 *
 * Link policy: only destinations that actually exist today are used —
 * `/signup`, `/login`, `/app`, and hash anchors into this page. Nothing here
 * may point at a route the application does not implement.
 */
import type { LandingContent } from "./types";

export const landingContent: LandingContent = {
  seo: {
    title: "Icooro — From idea to production-ready video",
    description:
      "Icooro is an AI video production platform: plan the story, script, scenes and shots, generate media with your providers, and track every job in one workspace.",
  },

  brand: {
    name: "Icooro",
  },

  header: {
    nav: [
      { label: "How it works", href: "#workflow" },
      { label: "Features", href: "#features" },
      { label: "Showcase", href: "#showcase" },
    ],
    signIn: { label: "Sign in", to: "/login" },
    signUp: { label: "Create account", to: "/signup" },
    themeToggleLabel: "Switch colour theme",
  },

  hero: {
    eyebrow: "AI video production platform",
    headline: "From idea to production-ready video.",
    supporting:
      "Plan the story, script, scenes and shots in one structured production plan, generate media with your own providers, and follow every job from queued to completed — without leaving the workspace.",
    primaryCta: { label: "Create your account", to: "/signup" },
    secondaryCta: { label: "Sign in", to: "/login" },
    preview: {
      title: "Production plan",
      stagesLabel: "Plan stages",
      stages: [
        { label: "Story", state: "done" },
        { label: "Script", state: "done" },
        { label: "Scenes", state: "done" },
        { label: "Shots", state: "active" },
        { label: "Generation", state: "pending" },
        { label: "Tracking", state: "pending" },
      ],
      listLabel: "Shots in Scene 04",
      rows: [
        { label: "Shot 01 — Opening wide", status: "Ready", tone: "success" },
        { label: "Shot 02 — Approach", status: "Prompt drafted", tone: "success" },
        { label: "Shot 03 — Reaction", status: "In review", tone: "pending" },
        { label: "Shot 04 — Closing frame", status: "Draft", tone: "pending" },
      ],
      note: "Product preview — illustrative content, not live project data.",
    },
  },

  workflow: {
    eyebrow: "How it works",
    title: "One workflow, from first beat to final shot",
    description:
      "Every production follows the same reviewable path. Each stage produces structured output the next stage builds on, and you stay in control between them.",
    steps: [
      {
        id: "story",
        label: "Story",
        description: "Capture the premise, characters and episode structure in a production plan.",
        icon: "story",
      },
      {
        id: "script",
        label: "Script",
        description: "Turn the story into a structured script with beats and dialogue.",
        icon: "script",
      },
      {
        id: "scenes",
        label: "Scenes",
        description: "Break the script into tracked scenes you can review and adjust.",
        icon: "scenes",
      },
      {
        id: "shots",
        label: "Shots",
        description: "Split every scene into shots with framing, camera direction and duration.",
        icon: "shots",
      },
      {
        id: "generation",
        label: "Generation",
        description: "Draft a media prompt per shot and run generation as tracked jobs.",
        icon: "generation",
      },
      {
        id: "tracking",
        label: "Tracking",
        description: "Follow every job from queued to completed, in the plan and in the project.",
        icon: "tracking",
      },
    ],
  },

  features: {
    eyebrow: "What you get",
    title: "Built for structured, AI-native production",
    description:
      "Icooro keeps planning, generation and execution in the same model, so nothing is lost between a good idea and a finished shot.",
    items: [
      {
        id: "structured-planning",
        title: "Structured planning",
        description:
          "Stories, scripts, scenes and shots live in one production plan with explicit status — edit, review and approve before anything is generated.",
        icon: "planning",
      },
      {
        id: "ai-generation",
        title: "AI-powered generation",
        description:
          "Prompts are drafted per shot and submitted to the providers you configure. The generation job stays owned by Icooro, not by the provider.",
        icon: "ai",
      },
      {
        id: "execution-tracking",
        title: "Execution tracking",
        description:
          "Every job reports its state — queued, submitted, processing, downloading, completed — and can be refreshed from the plan view.",
        icon: "execution",
      },
      {
        id: "project-management",
        title: "Project management",
        description:
          "Organize work by project and episode, keep media assets versioned and approved, and move between stages without switching tools.",
        icon: "projects",
      },
    ],
  },

  showcase: {
    eyebrow: "Showcase",
    title: "The creative workflow, end to end",
    description:
      "A look at the kind of work Icooro supports: a story shaped into a script, broken down into scenes and shots, then generated and tracked to completion.",
    items: [
      {
        id: "story-outline",
        title: "Story outline",
        caption: "Premise, characters and episode structure, drafted in the workspace.",
        accent: "#2563eb",
        accentSoft: "#dce6ff",
      },
      {
        id: "scene-breakdown",
        title: "Scene breakdown",
        caption: "The script split into tracked scenes, ready for review.",
        accent: "#0f766e",
        accentSoft: "#d7efe9",
      },
      {
        id: "shot-list",
        title: "Shot list",
        caption: "Each scene divided into shots with framing, duration and a prompt.",
        accent: "#7c3aed",
        accentSoft: "#e8ddff",
      },
      {
        id: "generation-queue",
        title: "Generation queue",
        caption: "Jobs submitted to your providers and tracked through to completion.",
        accent: "#b45309",
        accentSoft: "#fde7c8",
      },
    ],
    note: "Representative previews of the Icooro workspace — illustrative, not live project data.",
  },

  closingCta: {
    title: "Start your first production",
    description:
      "Create a workspace, connect the providers you already use, and take a story from the first line to a tracked set of generations.",
    primaryCta: { label: "Create your account", to: "/signup" },
    secondaryCta: { label: "Sign in", to: "/login" },
  },

  footer: {
    tagline: "AI video production, end to end.",
    columns: [
      {
        title: "Product",
        links: [
          { label: "How it works", href: "#workflow" },
          { label: "Features", href: "#features" },
          { label: "Showcase", href: "#showcase" },
        ],
      },
      {
        title: "Account",
        links: [
          { label: "Sign in", to: "/login" },
          { label: "Create account", to: "/signup" },
          { label: "Open the app", to: "/app" },
        ],
      },
    ],
  },
};

export default landingContent;
