/**
 * F3.1 — Workspace navigation and state reliability.
 *
 * Tests:
 *   1. Canonical section registry (`~/workspace/sections`)
 *      - one ordered list of supported sections, unique slugs
 *      - project id extraction (including the create-project route)
 *      - canonical section URLs, including nested routes
 *   2. WorkspaceNav
 *      - renders every canonical section once, in canonical order
 *      - marks exactly the current section with `aria-current="page"`
 *      - keeps the owning section active on nested routes
 *      - is a named landmark
 *   3. ErrorBanner retry action
 *      - message-only usage is unchanged (no action, `role="alert"`)
 *      - `retryLabel` renders an action that emits `retry`
 *   4. Workspace state reliability (regression)
 *      - a failed section load renders a working retry that re-runs the load
 *      - the page-specific loading message is rendered (not silently dropped)
 *   5. Navigation hierarchy
 *      - the workspace shell owns the section nav
 *      - the layout shows project context only while a project is active
 *      - the unimplemented Timeline / Export / Settings placeholders are gone
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref, reactive, computed } from "vue";

// Expose Vue globals
(globalThis as any).ref = ref;
(globalThis as any).reactive = reactive;
(globalThis as any).computed = computed;
(globalThis as any).defineComponent = defineComponent;
(globalThis as any).h = h;
(globalThis as any).onMounted = (await import("vue")).onMounted;
(globalThis as any).onBeforeUnmount = (await import("vue")).onBeforeUnmount;
(globalThis as any).watch = (await import("vue")).watch;
(globalThis as any).useId = (await import("vue")).useId;
(globalThis as any).readonly = (await import("vue")).readonly;

// Nuxt component stubs
const NuxtLinkStub = defineComponent({
  name: "NuxtLink",
  props: ["to"],
  setup(props, { slots }) {
    return () => h("a", { href: typeof props.to === "string" ? props.to : "#" }, slots.default?.());
  },
});

const NuxtPageStub = defineComponent({
  name: "NuxtPage",
  setup(_props, { slots }) {
    return () => h("div", { class: "nuxt-page-stub" }, slots.default?.());
  },
});

const BaseButton = (await import("../components/base/BaseButton.vue")).default;
const BaseInput = (await import("../components/base/BaseInput.vue")).default;
const BaseTextarea = (await import("../components/base/BaseTextarea.vue")).default;
const BaseSelect = (await import("../components/base/BaseSelect.vue")).default;
const BasePanel = (await import("../components/base/BasePanel.vue")).default;
const BaseCard = (await import("../components/base/BaseCard.vue")).default;
const EmptyState = (await import("../components/base/EmptyState.vue")).default;
const LoadingState = (await import("../components/base/LoadingState.vue")).default;
const ErrorBanner = (await import("../components/base/ErrorBanner.vue")).default;
const StatusPill = (await import("../components/base/StatusPill.vue")).default;
const ConfirmDialog = (await import("../components/base/ConfirmDialog.vue")).default;
const WorkspaceNav = (await import("../components/workspace/WorkspaceNav.vue")).default;

const commonGlobal = {
  stubs: {
    NuxtLink: NuxtLinkStub,
    NuxtPage: NuxtPageStub,
  },
  components: {
    BaseButton,
    BaseInput,
    BaseTextarea,
    BaseSelect,
    BasePanel,
    BaseCard,
    EmptyState,
    LoadingState,
    ErrorBanner,
    StatusPill,
    ConfirmDialog,
    WorkspaceNav,
  },
};

const runtimeConfigMock = { public: { apiBase: "http://api.test" } };
(globalThis as any).useRuntimeConfig = () => runtimeConfigMock;
(globalThis as any).useState = <T>(_key: string, init: () => T) => {
  return ref(init()) as unknown as ReturnType<typeof import("vue").useState>;
};
(globalThis as any).navigateTo = vi.fn();
(globalThis as any).defineNuxtRouteMiddleware = (fn: unknown) => fn;
(globalThis as any).definePageMeta = () => {};
(globalThis as any).useNuxtApp = () => ({});
(globalThis as any).$fetch = vi.fn();
(globalThis as any).resolveComponent = (name: string) => {
  if (name === "NuxtLink") return NuxtLinkStub;
  if (name === "NuxtPage") return NuxtPageStub;
  return name;
};

const { useWorkspaceProject } = await import("../composables/useWorkspaceProject");
(globalThis as any).useWorkspaceProject = useWorkspaceProject;

const sections = await import("../workspace/sections");
const {
  WORKSPACE_SECTIONS,
  WORKSPACE_SECTION_SLUGS,
  projectIdFromPath,
  workspaceSectionBySlug,
  workspaceSectionForPath,
  workspaceSectionPath,
} = sections;

const mockProject = {
  id: "proj_100",
  name: "Cyber Odyssey",
  description: "A cyberpunk sci-fi saga",
  status: "in_progress",
  ownerId: "u1",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-02T00:00:00.000Z",
};

/** Point the mocked router at a workspace path for the next mount. */
function routeAt(path: string) {
  const match = /^\/app\/projects\/([^/]+)/.exec(path);
  const projectId = match && match[1] !== "new" ? match[1] : "";
  (globalThis as any).useRoute = () => ({
    path,
    params: projectId ? { id: projectId } : {},
    query: {},
  });
  (globalThis as any).useRouter = () => ({ push: vi.fn().mockResolvedValue(undefined) });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("F3.1 canonical workspace sections", () => {
  it("exposes one canonical, ordered list of supported sections", () => {
    expect(WORKSPACE_SECTIONS.map((section) => section.slug)).toEqual([
      "plans",
      "story",
      "episodes",
      "scenes",
      "shots",
      "assets",
      "generations",
    ]);
    expect(WORKSPACE_SECTIONS.map((section) => section.label)).toEqual([
      "Plans",
      "Story",
      "Episodes",
      "Scenes",
      "Shots",
      "Assets",
      "Generations",
    ]);
    // Every section has a distinct slug and a description; no duplicates.
    expect(new Set(WORKSPACE_SECTION_SLUGS).size).toBe(WORKSPACE_SECTIONS.length);
    for (const section of WORKSPACE_SECTIONS) {
      expect(section.description.length).toBeGreaterThan(0);
    }
  });

  it("extracts the project id and ignores non-project routes", () => {
    expect(projectIdFromPath("/app/projects/proj_100/scenes")).toBe("proj_100");
    expect(projectIdFromPath("/app/projects/proj_100")).toBe("proj_100");
    // The create-project route is not a project.
    expect(projectIdFromPath("/app/projects/new")).toBeNull();
    expect(projectIdFromPath("/app/projects")).toBeNull();
    expect(projectIdFromPath("/app")).toBeNull();
    expect(projectIdFromPath("")).toBeNull();
    expect(projectIdFromPath(null)).toBeNull();
  });

  it("builds canonical section URLs and resolves the active section", () => {
    expect(workspaceSectionPath("proj_100", "shots")).toBe("/app/projects/proj_100/shots");

    expect(workspaceSectionForPath("/app/projects/proj_100/shots")?.slug).toBe("shots");
    // Nested routes belong to their owning section.
    expect(workspaceSectionForPath("/app/projects/proj_100/plans/plan_9")?.slug).toBe("plans");
    // A project route without a section, an unsupported slug, and a non-project
    // route all resolve to "no section".
    expect(workspaceSectionForPath("/app/projects/proj_100")).toBeNull();
    expect(workspaceSectionForPath("/app/projects/proj_100/unknown")).toBeNull();
    expect(workspaceSectionForPath("/app/projects/new")).toBeNull();
    expect(workspaceSectionBySlug("shots")?.label).toBe("Shots");
    expect(workspaceSectionBySlug("unknown")).toBeNull();
  });
});

describe("F3.1 WorkspaceNav", () => {
  it("renders every canonical section with canonical routes and an active marker", async () => {
    routeAt("/app/projects/proj_100/scenes");

    const wrapper = mount(WorkspaceNav, {
      props: { projectId: "proj_100" },
      global: commonGlobal,
    });

    const nav = wrapper.get("nav");
    expect(nav.attributes("aria-label")).toBe("Project sections");

    const links = wrapper.findAll("a");
    expect(links.map((link) => link.text())).toEqual(
      WORKSPACE_SECTIONS.map((section) => section.label),
    );
    expect(links.map((link) => link.attributes("href"))).toEqual(
      WORKSPACE_SECTIONS.map((section) => workspaceSectionPath("proj_100", section.slug)),
    );

    // Exactly one section is current, and assistive tech can see it.
    const current = links.filter((link) => link.attributes("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]!.text()).toBe("Scenes");
  });

  it("keeps the owning section current on nested routes", async () => {
    routeAt("/app/projects/proj_100/plans/plan_9");

    const wrapper = mount(WorkspaceNav, {
      props: { projectId: "proj_100" },
      global: commonGlobal,
    });

    const current = wrapper
      .findAll("a")
      .filter((link) => link.attributes("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]!.text()).toBe("Plans");
  });

  it("marks no section current when the route has none", async () => {
    routeAt("/app/projects/proj_100");

    const wrapper = mount(WorkspaceNav, {
      props: { projectId: "proj_100" },
      global: commonGlobal,
    });

    expect(wrapper.findAll("a")).toHaveLength(WORKSPACE_SECTIONS.length);
    expect(
      wrapper.findAll("a").filter((link) => link.attributes("aria-current") === "page"),
    ).toHaveLength(0);
  });
});

describe("F3.1 ErrorBanner retry action", () => {
  it("keeps message-only usage unchanged", () => {
    const wrapper = mount(ErrorBanner, { props: { message: "Failed to load episodes" } });

    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.text()).toBe("Failed to load episodes");
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("renders a retry action and emits retry", async () => {
    const wrapper = mount(ErrorBanner, {
      props: { message: "Failed to load episodes", retryLabel: "Retry" },
    });

    const button = wrapper.get("button");
    expect(button.text()).toBe("Retry");
    expect(button.attributes("type")).toBe("button");

    await button.trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
  });
});

describe("F3.1 workspace section reliability", () => {
  it("renders the page-specific loading message while a section loads", async () => {
    (globalThis as any).useApi = () => ({
      // Never settles: the view stays in its loading state.
      get: vi.fn(() => new Promise(() => {})),
      post: vi.fn(),
      delete: vi.fn(),
    });
    routeAt("/app/projects/proj_100/episodes");

    const EpisodesView = (await import("../pages/app/projects/[id]/episodes.vue")).default;
    const wrapper = mount(EpisodesView, { global: commonGlobal });
    await flushPromises();

    expect(wrapper.get(".loading-state").text()).toContain("Loading episodes…");
  });

  it("re-runs the section load when the retry action is used", async () => {
    const episodesPath = "/projects/proj_100/episodes";
    let attempts = 0;
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === episodesPath) {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("Unable to reach the API"));
        return Promise.resolve([
          {
            id: "ep1",
            projectId: "proj_100",
            title: "Pilot Episode",
            episodeNumber: 1,
            status: "draft",
          },
        ]);
      }
      if (path === "/episodes/ep1/script") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    (globalThis as any).useApi = () => ({ get, post: vi.fn(), delete: vi.fn() });
    routeAt("/app/projects/proj_100/episodes");

    const EpisodesView = (await import("../pages/app/projects/[id]/episodes.vue")).default;
    const wrapper = mount(EpisodesView, { global: commonGlobal });
    await flushPromises();

    // The failure is announced and offers a retry (it used to render nothing).
    expect(wrapper.text()).toContain("Unable to reach the API");
    expect(get.mock.calls.filter((call) => call[0] === episodesPath)).toHaveLength(1);

    const retry = wrapper.get(".error-banner button");
    expect(retry.text()).toBe("Retry");

    await retry.trigger("click");
    await flushPromises();

    // The retry re-ran the real load function and the section recovered.
    expect(get.mock.calls.filter((call) => call[0] === episodesPath)).toHaveLength(2);
    expect(wrapper.find(".error-banner").exists()).toBe(false);
    expect(wrapper.text()).toContain("Pilot Episode");
    expect(wrapper.text()).toContain("EP 1");
  });

  it("keeps the shell's retry wired to the project load", async () => {
    let attempts = 0;
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100") {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("Project temporarily unavailable"));
        return Promise.resolve(mockProject);
      }
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });
    (globalThis as any).useApi = () => ({ get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() });
    routeAt("/app/projects/proj_100/shots");

    const WorkspaceShell = (await import("../pages/app/projects/[id].vue")).default;
    const wrapper = mount(WorkspaceShell, { global: commonGlobal });
    await flushPromises();

    expect(wrapper.text()).toContain("Project temporarily unavailable");

    await wrapper.get(".error-banner button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Cyber Odyssey");
  });
});

describe("F3.1 navigation hierarchy", () => {
  it("gives the section navigation to the workspace shell", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100") return Promise.resolve(mockProject);
        return Promise.reject(new Error(`Unknown path: ${path}`));
      }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    });
    routeAt("/app/projects/proj_100/shots");

    const WorkspaceShell = (await import("../pages/app/projects/[id].vue")).default;
    const wrapper = mount(WorkspaceShell, { global: commonGlobal });
    await flushPromises();

    const links = wrapper.findAll("nav[aria-label='Project sections'] a");
    expect(links.map((link) => link.text())).toEqual(
      WORKSPACE_SECTIONS.map((section) => section.label),
    );

    const current = links.filter((link) => link.attributes("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]!.text()).toBe("Shots");

    // There is exactly one project-section navigation, not two.
    expect(wrapper.findAll("nav[aria-label='Project sections']")).toHaveLength(1);
  });

  it("shows project context in the layout only while a project is active", async () => {
    (globalThis as any).useAuth = () => ({ user: ref(null), logout: vi.fn() });
    const AppLayout = (await import("../layouts/app.vue")).default;

    // Outside a project: global navigation only.
    routeAt("/app/projects");
    const outside = mount(AppLayout, {
      slots: { default: () => h("div", "page") },
      global: commonGlobal,
    });
    expect(outside.text()).not.toContain("Current project");
    expect(outside.find(".project-context").exists()).toBe(false);

    // Inside a project: orientation for the section being worked in.
    routeAt("/app/projects/proj_1/scenes");
    const inside = mount(AppLayout, {
      slots: { default: () => h("div", "page") },
      global: commonGlobal,
    });
    expect(inside.text()).toContain("Current project");
    const context = inside.get(".project-context");
    expect(context.text()).toBe("Scenes");
    expect(context.attributes("href")).toBe("/app/projects/proj_1/scenes");
  });

  it("no longer links to unimplemented destinations", async () => {
    (globalThis as any).useAuth = () => ({ user: ref(null), logout: vi.fn() });
    routeAt("/app/projects/proj_1/scenes");

    const AppLayout = (await import("../layouts/app.vue")).default;
    const wrapper = mount(AppLayout, {
      slots: { default: () => h("div", "page") },
      global: commonGlobal,
    });

    const text = wrapper.text();
    expect(text).not.toContain("Timeline");
    expect(text).not.toContain("Export");
    expect(text).not.toContain("Settings");
    expect(wrapper.find(".placeholder").exists()).toBe(false);
  });
});
