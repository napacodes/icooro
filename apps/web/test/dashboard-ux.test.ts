/**
 * F2 — User dashboard UX tests.
 *
 * Guards the pieces the dashboard redesign must keep working:
 *   1. `DashboardHeader` — greeting, primary create-project action.
 *   2. `ProjectCard` — real project fields, status tone, workspace link,
 *      accessible labelling and the missing-description fallback.
 *   3. The `/app` page — loading, error + retry, empty, and populated states,
 *      using only real API data (no fabricated statistics).
 *
 * Runs under Vitest + happy-dom in the same style as the other web suites:
 * Nuxt auto-imports are exposed on `globalThis`, `NuxtLink` is stubbed.
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
(globalThis as any).readonly = (await import("vue")).readonly;
(globalThis as any).useId = (await import("vue")).useId;

// Nuxt component stubs
const NuxtLinkStub = defineComponent({
  name: "NuxtLink",
  props: ["to"],
  setup(props, { slots }) {
    return () => h("a", { href: typeof props.to === "string" ? props.to : "#" }, slots.default?.());
  },
});

const BaseButton = (await import("../components/base/BaseButton.vue")).default;
const EmptyState = (await import("../components/base/EmptyState.vue")).default;
const LoadingState = (await import("../components/base/LoadingState.vue")).default;
const ErrorBanner = (await import("../components/base/ErrorBanner.vue")).default;
const StatusPill = (await import("../components/base/StatusPill.vue")).default;

const commonGlobal = {
  stubs: { NuxtLink: NuxtLinkStub },
  components: { BaseButton, EmptyState, LoadingState, ErrorBanner, StatusPill },
};

(globalThis as any).useRuntimeConfig = () => ({ public: { apiBase: "http://api.test" } });
(globalThis as any).useState = <T>(_key: string, init: () => T) => ref(init());
(globalThis as any).navigateTo = vi.fn();
(globalThis as any).definePageMeta = () => {};
(globalThis as any).defineNuxtRouteMiddleware = (fn: unknown) => fn;
(globalThis as any).useNuxtApp = () => ({});
(globalThis as any).resolveComponent = (name: string) => {
  const map: Record<string, unknown> = { NuxtLink: NuxtLinkStub, ...commonGlobal.components };
  return map[name] ?? name;
};

const mockUser = {
  id: "u1",
  email: "filmmaker@example.com",
  name: "Filmmaker Alice",
  role: "user" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

(globalThis as any).useAuth = () => ({
  user: computed(() => mockUser),
  isAuthenticated: computed(() => true),
  isAdmin: computed(() => false),
});

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Neon Horizon",
    description: "Cyberpunk thriller set in Neo Tokyo",
    status: "in_progress",
    ownerId: "u1",
    createdAt: "2026-02-15T10:00:00.000Z",
    updatedAt: "2026-02-16T14:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).navigateTo = vi.fn();
});

// ---------------------------------------------------------------------------
// 1. DashboardHeader
// ---------------------------------------------------------------------------

describe("DashboardHeader", () => {
  it("greets the signed-in user and offers the primary create-project action", async () => {
    const DashboardHeader = (await import("../components/dashboard/DashboardHeader.vue")).default;
    const wrapper = mount(DashboardHeader, {
      props: { userName: "Filmmaker Alice" },
      global: commonGlobal,
    });

    expect(wrapper.find("h1").text()).toBe("Dashboard");
    expect(wrapper.text()).toContain("Filmmaker Alice");

    const cta = wrapper.find("a.btn-primary");
    expect(cta.exists()).toBe(true);
    expect(cta.attributes("href")).toBe("/app/projects/new");
    expect(cta.text()).toContain("New project");
  });

  it("falls back to a loading greeting while the session is unavailable", async () => {
    const DashboardHeader = (await import("../components/dashboard/DashboardHeader.vue")).default;
    const wrapper = mount(DashboardHeader, { props: { userName: null }, global: commonGlobal });
    expect(wrapper.text()).toContain("Loading workspace");
  });
});

// ---------------------------------------------------------------------------
// 2. ProjectCard
// ---------------------------------------------------------------------------

describe("ProjectCard", () => {
  it("renders real project fields and links into the workspace", async () => {
    const ProjectCard = (await import("../components/dashboard/ProjectCard.vue")).default;
    const wrapper = mount(ProjectCard, {
      props: { project: makeProject() },
      global: commonGlobal,
    });

    expect(wrapper.text()).toContain("Neon Horizon");
    expect(wrapper.text()).toContain("Cyberpunk thriller set in Neo Tokyo");
    expect(wrapper.text()).toContain("in_progress");

    const link = wrapper.find("a.open-link");
    expect(link.attributes("href")).toBe("/app/projects/p1");
    expect(link.text()).toContain("Open workspace");
  });

  it("maps status onto the shared StatusPill tone", async () => {
    const ProjectCard = (await import("../components/dashboard/ProjectCard.vue")).default;
    const wrapper = mount(ProjectCard, {
      props: { project: makeProject({ status: "archived" }) },
      global: commonGlobal,
    });

    const pill = wrapper.find(".status-pill");
    expect(pill.exists()).toBe(true);
    expect(pill.classes()).toContain("is-danger");
  });

  it("shows a fallback when the project has no description", async () => {
    const ProjectCard = (await import("../components/dashboard/ProjectCard.vue")).default;
    const wrapper = mount(ProjectCard, {
      props: { project: makeProject({ description: null }) },
      global: commonGlobal,
    });

    expect(wrapper.text()).toContain("No description provided.");
  });

  it("labels the card by its project title for assistive technology", async () => {
    const ProjectCard = (await import("../components/dashboard/ProjectCard.vue")).default;
    const wrapper = mount(ProjectCard, {
      props: { project: makeProject({ id: "abc" }) },
      global: commonGlobal,
    });

    const article = wrapper.find("article");
    const labelledBy = article.attributes("aria-labelledby");
    expect(labelledBy).toBe("project-abc-title");
    expect(wrapper.find(`#${labelledBy}`).text()).toBe("Neon Horizon");
  });
});

// ---------------------------------------------------------------------------
// 3. Dashboard page states
// ---------------------------------------------------------------------------

describe("User dashboard (/app) states", () => {
  it("shows a loading announcement before projects resolve", async () => {
    let resolveProjects!: (value: unknown) => void;
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockReturnValue(new Promise((resolve) => (resolveProjects = resolve))),
    });

    const DashboardPage = (await import("../pages/app/index.vue")).default;
    const wrapper = mount(DashboardPage as any, { global: commonGlobal });

    // Not flushed yet: the request is still pending.
    const status = wrapper.find('[role="status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toContain("Loading your dashboard");

    resolveProjects([]);
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it("renders recent project cards and the real project count only", async () => {
    const mockProjects = [
      makeProject(),
      makeProject({ id: "p2", name: "Desert Echoes", description: "Post-apocalyptic exploration", status: "draft" }),
    ];
    (globalThis as any).useApi = () => ({ get: vi.fn().mockResolvedValue(mockProjects) });

    const DashboardPage = (await import("../pages/app/index.vue")).default;
    const wrapper = mount(DashboardPage as any, { global: commonGlobal });
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("Filmmaker Alice");
    expect(text).toContain("Neon Horizon");
    expect(text).toContain("Desert Echoes");
    expect(text).toContain("Total Projects");

    // The only statistic is the true project count.
    expect(wrapper.find(".stat-value").text()).toBe("2");

    const grid = wrapper.find('ul[aria-label="Recent projects"]');
    expect(grid.exists()).toBe(true);
    expect(grid.findAll("article")).toHaveLength(2);
    expect(grid.findAll("a.open-link").map((a) => a.attributes("href"))).toEqual([
      "/app/projects/p1",
      "/app/projects/p2",
    ]);
  });

  it("offers a retry that reloads the dashboard after a failure", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network connection error"))
      .mockResolvedValueOnce([makeProject()]);
    (globalThis as any).useApi = () => ({ get });

    const DashboardPage = (await import("../pages/app/index.vue")).default;
    const wrapper = mount(DashboardPage as any, { global: commonGlobal });
    await flushPromises();

    expect(wrapper.text()).toContain("Network connection error");

    const retry = wrapper.find(".retry-btn");
    expect(retry.exists()).toBe(true);
    await retry.trigger("click");
    await flushPromises();

    expect(get).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("Neon Horizon");
    expect(wrapper.text()).not.toContain("Network connection error");
  });

  it("shows the empty state with a create action when there are no projects", async () => {
    (globalThis as any).useApi = () => ({ get: vi.fn().mockResolvedValue([]) });

    const DashboardPage = (await import("../pages/app/index.vue")).default;
    const wrapper = mount(DashboardPage as any, { global: commonGlobal });
    await flushPromises();

    expect(wrapper.text()).toContain("No projects yet");
    expect(wrapper.text()).toContain("Create your first project");

    const actions = wrapper.findAll('a[href="/app/projects/new"]');
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.some((a) => a.text().includes("Create your first project"))).toBe(true);
  });
});
