/**
 * Canonical project-section registry (F3.1).
 *
 * This is the ONE place that defines which sections a project workspace has,
 * in which order, and under which URL. Both the workspace shell navigation
 * (`components/workspace/WorkspaceNav.vue`) and the authenticated layout's
 * project context (`layouts/app.vue`) read from here, so the two can no longer
 * disagree about section names, ordering, or destinations.
 *
 * The list is deliberately literal: it must describe only sections that
 * actually exist as routes (`pages/app/projects/[id]/*`). Future destinations
 * (timeline, export, settings) are NOT listed until they are implemented —
 * they used to render as dead placeholder links.
 */

export const WORKSPACE_SECTIONS = [
  {
    slug: "plans",
    label: "Plans",
    description: "AI-assisted planning drafts and orchestration for this project.",
  },
  {
    slug: "story",
    label: "Story",
    description: "Characters, locations, and props that make up the story world.",
  },
  {
    slug: "episodes",
    label: "Episodes",
    description: "Episodic structure and script revisions.",
  },
  {
    slug: "scenes",
    label: "Scenes",
    description: "Scene breakdown for the active episode.",
  },
  {
    slug: "shots",
    label: "Shots",
    description: "Camera, framing, prompts, and shot versions.",
  },
  {
    slug: "assets",
    label: "Assets",
    description: "Media assets, versions, and approval state.",
  },
  {
    slug: "generations",
    label: "Generations",
    description: "AI generation jobs and their results.",
  },
] as const;

/** One canonical project section. */
export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number];

/** The slug union of every supported project section. */
export type WorkspaceSectionSlug = WorkspaceSection["slug"];

/** Every supported section slug, in canonical order. Exported for tests. */
export const WORKSPACE_SECTION_SLUGS: readonly WorkspaceSectionSlug[] =
  WORKSPACE_SECTIONS.map((section) => section.slug);

/** Route prefix shared by every authenticated project route. */
const PROJECTS_PREFIX = "/app/projects/";

/** The reserved path segment for creating a project; never a project id. */
const NEW_PROJECT_SEGMENT = "new";

/**
 * Extract the project id from a workspace path.
 *
 * Returns `null` for anything that is not a concrete project — the projects
 * index, the create-project route (`/app/projects/new`), and every non-project
 * path such as `/app` or `/app/projects`.
 */
export function projectIdFromPath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith(PROJECTS_PREFIX)) return null;
  const segment = path.slice(PROJECTS_PREFIX.length).split("/")[0] ?? "";
  if (!segment || segment === NEW_PROJECT_SEGMENT) return null;
  return segment;
}

/** Canonical URL for one section of one project. */
export function workspaceSectionPath(
  projectId: string,
  slug: WorkspaceSectionSlug,
): string {
  return `/app/projects/${projectId}/${slug}`;
}

/** Look a section up by its slug; `null` when the slug is not supported. */
export function workspaceSectionBySlug(
  slug: string | null | undefined,
): WorkspaceSection | null {
  if (!slug) return null;
  return WORKSPACE_SECTIONS.find((section) => section.slug === slug) ?? null;
}

/**
 * Resolve the section a workspace path points at.
 *
 * Nested routes resolve to their owning section, so a plan detail route
 * (`/app/projects/:id/plans/:planId`) keeps "Plans" active. Returns `null`
 * for project routes without a section (the shell redirects those) and for
 * unsupported slugs.
 */
export function workspaceSectionForPath(path: string | null | undefined): WorkspaceSection | null {
  const projectId = projectIdFromPath(path);
  if (!path || !projectId) return null;
  const slug = path.slice(`${PROJECTS_PREFIX}${projectId}/`.length).split("/")[0] ?? "";
  return workspaceSectionBySlug(slug);
}
