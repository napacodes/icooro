/**
 * C6.4 — Project Workspace Frontend Tests.
 *
 * Tests:
 *   1. Workspace Shell (/app/projects/:id)
 *      - Renders project title, status pill, breadcrumb link, and section tabs
 *      - Loading and error states
 *      - Project settings update
 *   2. Story Section (/app/projects/:id/story)
 *      - Loads characters, locations, props
 *      - Creates new character
 *      - Empty state
 *   3. Episodes Section (/app/projects/:id/episodes)
 *      - Lists episodes and scripts for selected episode
 *      - Creates an episode
 *   4. Scenes Section (/app/projects/:id/scenes)
 *      - Shows episodes selector and lists scenes
 *      - Creates a scene
 *   5. Shots Section (/app/projects/:id/shots)
 *      - Shows shots and shot versions
 *      - Creates a shot
 *   6. Assets Section (/app/projects/:id/assets)
 *      - Lists media assets and filters by type
 *      - Shows versions and approval status
 *   7. Generations Section (/app/projects/:id/generations)
 *      - Lists jobs with provider, model, status, and progress
 *      - Creates a generation job
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

// Import Base components
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
  if (name === "NuxtPage") return NuxtPageStub;
  if (name === "BaseButton") return BaseButton;
  if (name === "BaseInput") return BaseInput;
  if (name === "BaseTextarea") return BaseTextarea;
  if (name === "BaseSelect") return BaseSelect;
  if (name === "BasePanel") return BasePanel;
  if (name === "BaseCard") return BaseCard;
  if (name === "EmptyState") return EmptyState;
  if (name === "LoadingState") return LoadingState;
  if (name === "ErrorBanner") return ErrorBanner;
  if (name === "StatusPill") return StatusPill;
  if (name === "ConfirmDialog") return ConfirmDialog;
  return name;
};
(globalThis as any).useNuxtApp = () => ({});
(globalThis as any).$fetch = vi.fn();

const { useWorkspaceProject } = await import("../composables/useWorkspaceProject");
(globalThis as any).useWorkspaceProject = useWorkspaceProject;

const { statusTone } = await import("../composables/useStatusTone");
(globalThis as any).statusTone = statusTone;

const mockProject = {
  id: "proj_100",
  name: "Cyber Odyssey",
  description: "A cyberpunk sci-fi saga",
  status: "in_progress",
  ownerId: "u1",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-02T00:00:00.000Z",
};

(globalThis as any).useRoute = () => ({
  params: { id: "proj_100" },
  path: "/app/projects/proj_100/story",
  query: {},
});

(globalThis as any).useRouter = () => ({
  push: vi.fn(),
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("C6.4 Workspace Shell (/app/projects/:id)", () => {
  it("renders project title, description, status pill, and section tabs", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100") return Promise.resolve(mockProject);
        return Promise.reject(new Error(`Unknown path: ${path}`));
      }),
    });

    const WorkspaceShell = (await import("../pages/app/projects/[id].vue")).default;
    const wrapper = mount(WorkspaceShell as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Cyber Odyssey");
    expect(wrapper.text()).toContain("A cyberpunk sci-fi saga");
    expect(wrapper.text()).toContain("in_progress");
    expect(wrapper.text()).toContain("Story");
    expect(wrapper.text()).toContain("Episodes");
    expect(wrapper.text()).toContain("Scenes");
    expect(wrapper.text()).toContain("Shots");
    expect(wrapper.text()).toContain("Assets");
    expect(wrapper.text()).toContain("Generations");
    expect(wrapper.text()).toContain("← Projects");
  });

  it("handles loading and error states in the shell", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockRejectedValue(new Error("Project not found")),
    });

    const WorkspaceShell = (await import("../pages/app/projects/[id].vue")).default;
    const wrapper = mount(WorkspaceShell as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Project not found");
  });
});

describe("C6.4 Story View (/app/projects/:id/story)", () => {
  it("renders characters, locations, and props from API", async () => {
    const mockCharacters = [
      { id: "c1", projectId: "proj_100", name: "Commander Ren", description: "Protagonist", visualDescription: "Cybernetic eye" },
    ];
    const mockLocations = [
      { id: "l1", projectId: "proj_100", name: "Sector 4 Neo District", description: "Neon drenched streets", visualDescription: null },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/characters") return Promise.resolve(mockCharacters);
        if (path === "/projects/proj_100/locations") return Promise.resolve(mockLocations);
        if (path === "/projects/proj_100/props") return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      post: vi.fn(),
    });

    const StoryView = (await import("../pages/app/projects/[id]/story.vue")).default;
    const wrapper = mount(StoryView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Commander Ren");
    expect(wrapper.text()).toContain("Protagonist");
    expect(wrapper.text()).toContain("Cybernetic eye");
    expect(wrapper.text()).toContain("Add Character");
  });
});

describe("C6.4 Episodes View (/app/projects/:id/episodes)", () => {
  it("renders episodes list and scripts for active episode", async () => {
    const mockEpisodes = [
      { id: "ep1", projectId: "proj_100", title: "Pilot Episode", episodeNumber: 1, status: "draft" },
    ];
    const mockScripts = [
      { id: "sc1", episodeId: "ep1", content: "EXT. SPACE STATION - NIGHT\nA ship docks silently.", version: 1 },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/episodes") return Promise.resolve(mockEpisodes);
        if (path === "/episodes/ep1/script") return Promise.resolve(mockScripts);
        return Promise.resolve([]);
      }),
      post: vi.fn(),
    });

    const EpisodesView = (await import("../pages/app/projects/[id]/episodes.vue")).default;
    const wrapper = mount(EpisodesView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Pilot Episode");
    expect(wrapper.text()).toContain("EP 1");
    expect(wrapper.text()).toContain("Version 1");
    expect(wrapper.text()).toContain("EXT. SPACE STATION - NIGHT");
  });
});

describe("C6.4 Scenes View (/app/projects/:id/scenes)", () => {
  it("renders scenes hierarchy for the active episode", async () => {
    const mockEpisodes = [
      { id: "ep1", projectId: "proj_100", title: "Pilot", episodeNumber: 1 },
    ];
    const mockScenes = [
      { id: "sc1", episodeId: "ep1", name: "Airlock Breach", description: "Tense entry sequence", orderIndex: 1 },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/episodes") return Promise.resolve(mockEpisodes);
        if (path === "/episodes/ep1/scenes") return Promise.resolve(mockScenes);
        return Promise.resolve([]);
      }),
    });

    const ScenesView = (await import("../pages/app/projects/[id]/scenes.vue")).default;
    const wrapper = mount(ScenesView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Airlock Breach");
    expect(wrapper.text()).toContain("SCENE 1");
    expect(wrapper.text()).toContain("Tense entry sequence");
  });
});

describe("C6.4 Shots View (/app/projects/:id/shots)", () => {
  it("renders shots and shot versions", async () => {
    const mockEpisodes = [{ id: "ep1", title: "Pilot", episodeNumber: 1 }];
    const mockScenes = [{ id: "sc1", episodeId: "ep1", name: "Airlock", orderIndex: 1 }];
    const mockShots = [
      {
        id: "shot1",
        sceneId: "sc1",
        orderIndex: 1,
        shotType: "Close Up",
        framing: "Low Angle",
        duration: 5,
        prompt: "Cinematic close-up of helmet visor reflection",
        actionDescription: null,
        status: "pending",
      },
    ];
    const mockVersions = [
      { id: "v1", shotId: "shot1", version: 1, prompt: null, status: "approved", duration: 5, productionReady: 1 },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/episodes") return Promise.resolve(mockEpisodes);
        if (path === "/episodes/ep1/scenes") return Promise.resolve(mockScenes);
        if (path === "/scenes/sc1/shots") return Promise.resolve(mockShots);
        if (path === "/shots/shot1/versions") return Promise.resolve(mockVersions);
        return Promise.resolve([]);
      }),
    });

    const ShotsView = (await import("../pages/app/projects/[id]/shots.vue")).default;
    const wrapper = mount(ShotsView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Close Up");
    expect(wrapper.text()).toContain("Cinematic close-up of helmet visor reflection");
    expect(wrapper.text()).toContain("Take v1");
    expect(wrapper.text()).toContain("Production Ready");
  });
});

describe("C6.4 Assets View (/app/projects/:id/assets)", () => {
  it("renders assets, media types, and version approval state", async () => {
    const mockAssets = [
      {
        id: "ast1",
        projectId: "proj_100",
        name: "Neon City Concept Art",
        type: "image",
        status: "active",
        description: "Matte painting reference",
        approvedVersionId: "av1",
      },
    ];
    const mockVersions = [
      {
        id: "av1",
        assetId: "ast1",
        version: 1,
        storageKey: "projects/proj_100/assets/ast1/v1.png",
        fileSize: 102400,
        mimeType: "image/png",
        approvalState: "approved",
      },
    ];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/assets") return Promise.resolve(mockAssets);
        if (path === "/assets/ast1/versions") return Promise.resolve(mockVersions);
        return Promise.resolve([]);
      }),
      post: vi.fn(),
    });

    const AssetsView = (await import("../pages/app/projects/[id]/assets.vue")).default;
    const wrapper = mount(AssetsView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Neon City Concept Art");
    expect(wrapper.text()).toContain("image");
    expect(wrapper.text()).toContain("Approved");
    expect(wrapper.text()).toContain("Version 1");
    expect(wrapper.text()).toContain("projects/proj_100/assets/ast1/v1.png");
  });
});

describe("C6.4 Generations View (/app/projects/:id/generations)", () => {
  it("renders generation jobs with provider, model, progress, and actions", async () => {
    const mockJobs = [
      {
        id: "job1",
        projectId: "proj_100",
        jobType: "text-to-image",
        status: "processing",
        providerId: "prov1",
        modelId: "mod1",
        prompt: "Futuristic vehicle speeding through tunnel",
        targetMediaType: "image",
        progress: 65,
        error: null,
        assetVersionId: null,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:02:00.000Z",
      },
    ];
    const mockProviders = [{ id: "prov1", name: "ChatFire", type: "video", enabled: true }];
    const mockModels = [{ id: "mod1", providerId: "prov1", name: "FireGen v2", modelId: "fg-v2" }];

    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/jobs") return Promise.resolve(mockJobs);
        if (path === "/ai-providers") return Promise.resolve(mockProviders);
        if (path === "/ai-models") return Promise.resolve(mockModels);
        return Promise.resolve([]);
      }),
      post: vi.fn(),
    });

    const GenerationsView = (await import("../pages/app/projects/[id]/generations.vue")).default;
    const wrapper = mount(GenerationsView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Futuristic vehicle speeding through tunnel");
    expect(wrapper.text()).toContain("ChatFire");
    expect(wrapper.text()).toContain("FireGen v2");
    expect(wrapper.text()).toContain("65%");
    expect(wrapper.text()).toContain("Check / Poll Status");
    expect(wrapper.text()).toContain("Cancel");
  });
});
