/**
 * C6.2 — Admin Control Plane Frontend Tests.
 *
 * Tests the 6 admin pages:
 *   1. Admin Overview (index.vue)
 *   2. Admin Users (users/index.vue)
 *   3. Admin Projects (projects/index.vue)
 *   4. Admin AI Providers (providers/index.vue)
 *   5. Admin AI Models (models/index.vue)
 *   6. Admin Generation Jobs (jobs/index.vue)
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
  return name;
};
(globalThis as any).useNuxtApp = () => ({});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Admin Overview page", () => {
  it("fetches /admin/overview and displays metrics and status breakdown", async () => {
    const mockStats = {
      usersCount: 12,
      adminUsersCount: 2,
      projectsCount: 8,
      providersCount: 3,
      enabledProvidersCount: 2,
      modelsCount: 5,
      enabledModelsCount: 4,
      jobsCount: 42,
      jobsByStatus: {
        queued: 2,
        submitted: 1,
        processing: 3,
        downloading: 0,
        completed: 30,
        failed: 5,
        cancelled: 1,
      },
    };

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/admin/overview") return Promise.resolve(mockStats);
        return Promise.reject(new Error("Unknown path"));
      }),
    });

    const AdminOverviewPage = (await import("../pages/admin/index.vue")).default;
    const wrapper = mount(AdminOverviewPage as any, {
      global: {
        stubs: { NuxtLink: NuxtLinkStub },
      },
    });

    await flushPromises();

    const html = wrapper.html();
    expect(html).toContain("Control Plane Overview");
    expect(html).toContain("12"); // usersCount
    expect(html).toContain("8"); // projectsCount
    expect(html).toContain("42"); // jobsCount
    expect(html).toContain("Queued: 2");
    expect(html).toContain("Completed: 30");
    expect(html).toContain("Failed: 5");
  });
});

describe("Admin Users page", () => {
  it("fetches /admin/users, displays table, and toggles user role", async () => {
    const mockUsers = [
      {
        id: "u1",
        email: "alice@example.com",
        name: "Alice",
        role: "admin",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "u2",
        email: "bob@example.com",
        name: "Bob",
        role: "user",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ];

    const patchMock = vi.fn().mockResolvedValue({
      id: "u2",
      email: "bob@example.com",
      name: "Bob",
      role: "admin",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockUsers),
      patch: patchMock,
    });

    const AdminUsersPage = (await import("../pages/admin/users/index.vue")).default;
    const wrapper = mount(AdminUsersPage as any, {
      global: {
        stubs: { NuxtLink: NuxtLinkStub },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("Alice");
    expect(wrapper.text()).toContain("bob@example.com");
    expect(wrapper.text()).toContain("Demote to User");
    expect(wrapper.text()).toContain("Make Admin");

    // Click Make Admin on Bob
    const buttons = wrapper.findAll(".btn-action");
    expect(buttons.length).toBe(2);
    await buttons[1].trigger("click");
    await flushPromises();

    expect(patchMock).toHaveBeenCalledWith("/admin/users/u2", { role: "admin" });
    expect(wrapper.text()).not.toContain("Make Admin");
  });
});

describe("Admin Projects page", () => {
  it("fetches /admin/projects and displays project table with owner details", async () => {
    const mockProjects = [
      {
        id: "p1",
        name: "Epic Fantasy Movie",
        description: "A thrilling adventure",
        ownerId: "u1",
        ownerName: "Alice Creator",
        ownerEmail: "alice@example.com",
        status: "in_progress",
        createdAt: "2026-02-01T12:00:00.000Z",
      },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockProjects),
    });

    const AdminProjectsPage = (await import("../pages/admin/projects/index.vue")).default;
    const wrapper = mount(AdminProjectsPage as any, {
      global: {
        stubs: { NuxtLink: NuxtLinkStub },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("Epic Fantasy Movie");
    expect(wrapper.text()).toContain("Alice Creator");
    expect(wrapper.text()).toContain("alice@example.com");
    expect(wrapper.text()).toContain("in_progress");
  });
});

describe("Admin AI Providers page", () => {
  it("fetches /admin/providers and toggles enabled status", async () => {
    const mockProviders = [
      {
        id: "prov1",
        name: "ChatFire",
        providerType: "chatfire",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const patchMock = vi.fn().mockResolvedValue({
      id: "prov1",
      name: "ChatFire",
      providerType: "chatfire",
      enabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockProviders),
      patch: patchMock,
    });

    const AdminProvidersPage = (await import("../pages/admin/providers/index.vue")).default;
    const wrapper = mount(AdminProvidersPage as any, {
      global: {
        stubs: { NuxtLink: NuxtLinkStub },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("ChatFire");
    expect(wrapper.text()).toContain("Active");
    expect(wrapper.text()).toContain("Disable");

    const disableBtn = wrapper.find(".btn-action");
    await disableBtn.trigger("click");
    await flushPromises();

    expect(patchMock).toHaveBeenCalledWith("/admin/providers/prov1", { enabled: false });
    expect(wrapper.text()).toContain("Disabled");
  });
});

describe("Admin AI Models page", () => {
  it("fetches /admin/models and toggles model availability", async () => {
    const mockModels = [
      {
        id: "m1",
        providerId: "prov1",
        providerName: "ChatFire",
        name: "Seedance 2.0",
        modelId: "seedance-2.0",
        capability: "video",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const patchMock = vi.fn().mockResolvedValue({
      id: "m1",
      providerId: "prov1",
      providerName: "ChatFire",
      name: "Seedance 2.0",
      modelId: "seedance-2.0",
      capability: "video",
      enabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockModels),
      patch: patchMock,
    });

    const AdminModelsPage = (await import("../pages/admin/models/index.vue")).default;
    const wrapper = mount(AdminModelsPage as any, {
      global: {
        stubs: { NuxtLink: NuxtLinkStub },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("Seedance 2.0");
    expect(wrapper.text()).toContain("video");
    expect(wrapper.text()).toContain("ChatFire");
    expect(wrapper.text()).toContain("Active");

    const disableBtn = wrapper.find(".btn-action");
    await disableBtn.trigger("click");
    await flushPromises();

    expect(patchMock).toHaveBeenCalledWith("/admin/models/m1", { enabled: false });
    expect(wrapper.text()).toContain("Disabled");
  });
});

describe("Admin Generation Jobs page", () => {
  it("fetches /admin/jobs and allows cancelling an active job", async () => {
    (globalThis as any).confirm = vi.fn().mockReturnValue(true);

    const mockJobs = [
      {
        id: "job-abc",
        projectId: "p1",
        projectName: "My Film",
        jobType: "video",
        status: "processing",
        progress: 45,
        prompt: "A cinematic shot of a dragon",
        createdAt: "2026-03-01T10:00:00.000Z",
      },
      {
        id: "job-xyz",
        projectId: "p1",
        projectName: "My Film",
        jobType: "video",
        status: "completed",
        progress: 100,
        prompt: "Completed scene",
        createdAt: "2026-03-01T09:00:00.000Z",
      },
    ];

    const postMock = vi.fn().mockResolvedValue({
      id: "job-abc",
      status: "cancelled",
    });

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockJobs),
      post: postMock,
    });

    const AdminJobsPage = (await import("../pages/admin/jobs/index.vue")).default;
    const wrapper = mount(AdminJobsPage as any, {
      global: {
        stubs: { NuxtLink: NuxtLinkStub },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("job-abc");
    expect(wrapper.text()).toContain("processing");
    expect(wrapper.text()).toContain("45%");
    expect(wrapper.text()).toContain("completed");

    // Cancel button only for processing job
    const cancelBtn = wrapper.find(".btn-cancel");
    expect(cancelBtn.exists()).toBe(true);
    await cancelBtn.trigger("click");
    await flushPromises();

    expect(postMock).toHaveBeenCalledWith("/admin/jobs/job-abc/cancel");
    expect(wrapper.text()).toContain("cancelled");
  });
});
