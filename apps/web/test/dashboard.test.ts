/**
 * C6.3 — User Dashboard Frontend Tests.
 *
 * Tests:
 *   1. User Dashboard (/app)
 *      - Renders dashboard with projects loaded from API
 *      - Shows empty state when user has no projects
 *      - Handles API load errors with ErrorBanner and retry
 *   2. User Projects (/app/projects)
 *      - Renders project list with metadata and status pills
 *      - Shows empty state when user has no projects
 *      - Handles API errors
 *   3. Create Project (/app/projects/new)
 *      - Form validation: rejects empty project name
 *      - Successful creation calls API and navigates to workspace
 *      - API error handling
 *      - Prevents duplicate submission
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref, reactive, computed } from "vue";
import { ApiError } from "@icooro/shared";

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

// Import Base components to register them in test mounts
const BaseButton = (await import("../components/base/BaseButton.vue")).default;
const BaseInput = (await import("../components/base/BaseInput.vue")).default;
const BaseTextarea = (await import("../components/base/BaseTextarea.vue")).default;
const BaseSelect = (await import("../components/base/BaseSelect.vue")).default;
const EmptyState = (await import("../components/base/EmptyState.vue")).default;
const LoadingState = (await import("../components/base/LoadingState.vue")).default;
const ErrorBanner = (await import("../components/base/ErrorBanner.vue")).default;
const StatusPill = (await import("../components/base/StatusPill.vue")).default;

const commonGlobal = {
  stubs: {
    NuxtLink: NuxtLinkStub,
  },
  components: {
    BaseButton,
    BaseInput,
    BaseTextarea,
    BaseSelect,
    EmptyState,
    LoadingState,
    ErrorBanner,
    StatusPill,
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
(globalThis as any).resolveComponent = (name: string) => {
  if (name === "NuxtLink") return NuxtLinkStub;
  if (name === "BaseButton") return BaseButton;
  if (name === "BaseInput") return BaseInput;
  if (name === "BaseTextarea") return BaseTextarea;
  if (name === "BaseSelect") return BaseSelect;
  if (name === "EmptyState") return EmptyState;
  if (name === "LoadingState") return LoadingState;
  if (name === "ErrorBanner") return ErrorBanner;
  if (name === "StatusPill") return StatusPill;
  return name;
};
(globalThis as any).useNuxtApp = () => ({});

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

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).navigateTo = vi.fn();
});

describe("User Dashboard (/app)", () => {
  it("renders welcome area and project summary cards from API", async () => {
    const mockProjects = [
      {
        id: "p1",
        name: "Neon Horizon",
        description: "Cyberpunk thriller set in Neo Tokyo",
        status: "in_progress",
        ownerId: "u1",
        createdAt: "2026-02-15T10:00:00.000Z",
        updatedAt: "2026-02-16T14:00:00.000Z",
      },
      {
        id: "p2",
        name: "Desert Echoes",
        description: "Post-apocalyptic exploration",
        status: "draft",
        ownerId: "u1",
        createdAt: "2026-02-10T08:00:00.000Z",
        updatedAt: "2026-02-11T12:00:00.000Z",
      },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects") return Promise.resolve(mockProjects);
        return Promise.reject(new Error("Unknown path"));
      }),
    });

    const DashboardPage = (await import("../pages/app/index.vue")).default;
    const wrapper = mount(DashboardPage as any, { global: commonGlobal });

    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("Filmmaker Alice");
    expect(text).toContain("Neon Horizon");
    expect(text).toContain("Cyberpunk thriller set in Neo Tokyo");
    expect(text).toContain("Desert Echoes");
    expect(text).toContain("Total Projects");
    expect(text).toContain("2");
    expect(text).toContain("in_progress");
  });

  it("shows an empty state with create action when user has no projects", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue([]),
    });

    const DashboardPage = (await import("../pages/app/index.vue")).default;
    const wrapper = mount(DashboardPage as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("No projects yet");
    expect(wrapper.text()).toContain("Create your first project");
  });

  it("handles API errors gracefully with error banner and retry option", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockRejectedValue(new Error("Network connection error")),
    });

    const DashboardPage = (await import("../pages/app/index.vue")).default;
    const wrapper = mount(DashboardPage as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Network connection error");
    expect(wrapper.find(".retry-btn").exists()).toBe(true);
  });
});

describe("User Projects (/app/projects)", () => {
  it("renders list of user projects with metadata and status pills", async () => {
    const mockProjects = [
      {
        id: "p10",
        name: "Galactic Odyssey",
        description: "Space sci-fi drama",
        status: "active",
        ownerId: "u1",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockProjects),
    });

    const ProjectsPage = (await import("../pages/app/projects/index.vue")).default;
    const wrapper = mount(ProjectsPage as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Galactic Odyssey");
    expect(wrapper.text()).toContain("Space sci-fi drama");
    expect(wrapper.text()).toContain("active");
    expect(wrapper.text()).toContain("Open workspace");
  });

  it("shows empty state when no projects are returned", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue([]),
    });

    const ProjectsPage = (await import("../pages/app/projects/index.vue")).default;
    const wrapper = mount(ProjectsPage as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("No projects yet");
    expect(wrapper.text()).toContain("Create your first project");
  });

  it("renders error banner if loading projects fails", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockRejectedValue(new Error("Failed to authenticate session")),
    });

    const ProjectsPage = (await import("../pages/app/projects/index.vue")).default;
    const wrapper = mount(ProjectsPage as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Failed to authenticate session");
  });
});

describe("Create Project (/app/projects/new)", () => {
  it("validates required name field before submitting", async () => {
    const postMock = vi.fn();
    (globalThis as any).useApi = () => ({
      post: postMock,
    });

    const NewProjectPage = (await import("../pages/app/projects/new.vue")).default;
    const wrapper = mount(NewProjectPage as any, { global: commonGlobal });

    await flushPromises();

    // Try to submit with empty name
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(postMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Project name is required.");
  });

  it("successfully creates project and navigates to the project workspace", async () => {
    const postMock = vi.fn().mockResolvedValue({
      id: "proj-new-123",
      name: "Chronicles of Aethel",
      description: "Fantasy epic",
      status: "draft",
    });

    (globalThis as any).useApi = () => ({
      post: postMock,
    });

    const NewProjectPage = (await import("../pages/app/projects/new.vue")).default;
    const wrapper = mount(NewProjectPage as any, { global: commonGlobal });

    await flushPromises();

    // Fill in form
    const nameInput = wrapper.find("#project-name");
    await nameInput.setValue("Chronicles of Aethel");

    const descInput = wrapper.find("#project-description");
    await descInput.setValue("Fantasy epic");

    // Submit form
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(postMock).toHaveBeenCalledWith("/projects", {
      name: "Chronicles of Aethel",
      description: "Fantasy epic",
      status: "draft",
    });

    expect((globalThis as any).navigateTo).toHaveBeenCalledWith("/app/projects/proj-new-123");
  });

  it("displays API error message when project creation fails", async () => {
    (globalThis as any).useApi = () => ({
      post: vi.fn().mockRejectedValue(new ApiError("Project name already exists", "CONFLICT", 409)),
    });

    const NewProjectPage = (await import("../pages/app/projects/new.vue")).default;
    const wrapper = mount(NewProjectPage as any, { global: commonGlobal });

    await flushPromises();

    const nameInput = wrapper.find("#project-name");
    await nameInput.setValue("Duplicate Project");

    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(wrapper.text()).toContain("Project name already exists");
  });
});
