/**
 * C7.8 — Production Plan UI tests.
 *
 * Tests:
 *   1. Plans list view (/app/projects/:id/plans)
 *      - Lists plans with request, status, duration, dates
 *      - Empty state
 *      - Create plan (target duration and preferences)
 *      - Validation error, API error
 *   2. Plan detail view (/app/projects/:id/plans/:planId)
 *      - Shows request, status, meta
 *      - Orchestration request handling: body, duplicate prevention, refresh
 *      - Stage-by-stage report rendering (completed / skipped / partial / failed / not_run)
 *      - Missing-record and skipped notes
 *      - Error states (409 conflict, network failure)
 *      - Results overview and navigation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref, reactive, computed } from "vue";

// Expose Vue globals (same pattern as workspace.test.ts)
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
  return name;
};
(globalThis as any).useNuxtApp = () => ({});
(globalThis as any).$fetch = vi.fn();

const { useProductionPlans } = await import("../composables/useProductionPlans");
(globalThis as any).useProductionPlans = useProductionPlans;

const { statusTone } = await import("../composables/useStatusTone");
(globalThis as any).statusTone = statusTone;

(globalThis as any).useRoute = () => ({
  params: { id: "proj_100", planId: "plan_1" },
  path: "/app/projects/proj_100/plans/plan_1",
  query: {},
});

(globalThis as any).useRouter = () => ({
  push: vi.fn().mockResolvedValue(undefined),
});

const mockPlanRow = {
  id: "plan_1",
  projectId: "proj_100",
  episodeId: null,
  request: "Make a 30-second episode about colors",
  status: "planning",
  plan: null,
  targetDurationSeconds: 30,
  preferences: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const mockFullPlanRow = {
  ...mockPlanRow,
  plan: {
    story: {
      title: "The Day Colors Went Missing",
      premise: "Mozy wakes to find every color in Toonville has vanished.",
      characters: ["Mozy", "Mimi"],
    },
    episodeId: "ep_abc12345",
    scriptVersionId: "script_v1",
    sceneIds: ["scn_1", "scn_2", "scn_3"],
    shotIds: { scn_1: ["shot_1"], scn_2: ["shot_2", "shot_3"] },
    promptedShotIds: ["shot_1", "shot_2"],
  },
};

const mockReport = {
  productionPlanId: "plan_1",
  status: "completed",
  requestedTo: null,
  stages: [
    { stage: "story", status: "skipped", reason: "A valid story already exists.", skipped: 1 },
    { stage: "script", status: "skipped", reason: "Script already exists.", skipped: 1 },
    { stage: "scenes", status: "completed", generated: 3 },
    { stage: "shots", status: "completed", generated: 3 },
    { stage: "prompts", status: "completed", generated: 3 },
  ],
  plan: mockFullPlanRow.plan,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("C7.8 Plans list view (/app/projects/:id/plans)", () => {
  it("lists plans with request, status, duration, and dates", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/production-plans")
          return Promise.resolve([mockPlanRow]);
        return Promise.reject(new Error(`Unknown path: ${path}`));
      }),
    });

    const PlansView = (await import("../pages/app/projects/[id]/plans.vue")).default;
    const wrapper = mount(PlansView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("Make a 30-second episode about colors");
    expect(wrapper.text()).toContain("planning");
    expect(wrapper.text()).toContain("30 sec");
    expect(wrapper.text()).toContain("Open Plan");
    expect(wrapper.find(".open-link").attributes("href")).toBe(
      "/app/projects/proj_100/plans/plan_1",
    );
  });

  it("shows the empty state when no plans exist", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue([]),
    });

    const PlansView = (await import("../pages/app/projects/[id]/plans.vue")).default;
    const wrapper = mount(PlansView as any, { global: commonGlobal });

    await flushPromises();

    expect(wrapper.text()).toContain("No production plans yet");
    expect(wrapper.text()).toContain("Create a Plan");
  });

  it("creates a plan in one request with duration and preferences, no follow-up PATCH", async () => {
    const postMock = vi.fn().mockResolvedValue({ ...mockPlanRow, id: "plan_new" });
    const patchMock = vi.fn();
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue([mockPlanRow]),
      post: postMock,
      patch: patchMock,
    });
    const pushMock = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).useRouter = () => ({ push: pushMock });

    const PlansView = (await import("../pages/app/projects/[id]/plans.vue")).default;
    const wrapper = mount(PlansView as any, { global: commonGlobal });
    await flushPromises();

    // Open the create form.
    await wrapper.find(".view-header button").trigger("click");
    await flushPromises();

    const textareas = wrapper.findAll("textarea");
    await textareas[0]!.setValue("Make a 45-second episode about shapes");
    await textareas[1]!.setValue("Friendly tone for kids");
    await wrapper.find("input[type=number]").setValue("45");

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    // ONE request carries request, target duration, and preferences (C7.9).
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith("/projects/proj_100/production-plans", {
      request: "Make a 45-second episode about shapes",
      targetDurationSeconds: 45,
      preferences: { notes: "Friendly tone for kids" },
    });
    // No follow-up PATCH may be issued to set the duration.
    expect(patchMock).not.toHaveBeenCalled();
    // User lands on the new plan's detail view.
    expect(pushMock).toHaveBeenCalledWith("/app/projects/proj_100/plans/plan_new");
  });

  it("omits targetDurationSeconds from the create body when not provided", async () => {
    const postMock = vi.fn().mockResolvedValue({ ...mockPlanRow, id: "plan_new" });
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue([mockPlanRow]),
      post: postMock,
    });
    const pushMock = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).useRouter = () => ({ push: pushMock });

    const PlansView = (await import("../pages/app/projects/[id]/plans.vue")).default;
    const wrapper = mount(PlansView as any, { global: commonGlobal });
    await flushPromises();

    await wrapper.find(".view-header button").trigger("click");
    await flushPromises();

    const textareas = wrapper.findAll("textarea");
    await textareas[0]!.setValue("A story about numbers");
    // Leave the duration input empty.
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(postMock).toHaveBeenCalledWith("/projects/proj_100/production-plans", {
      request: "A story about numbers",
    });
    expect(pushMock).toHaveBeenCalled();
  });

  it("surfaces validation and API errors without navigating", async () => {
    const { ApiError } = await import("@icooro/shared");
    const postMock = vi
      .fn()
      .mockRejectedValue(new ApiError("request is required", "INVALID_REQUEST", 400));
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue([]),
      post: postMock,
    });
    const pushMock = vi.fn();
    (globalThis as any).useRouter = () => ({ push: pushMock });

    const PlansView = (await import("../pages/app/projects/[id]/plans.vue")).default;
    const wrapper = mount(PlansView as any, { global: commonGlobal });
    await flushPromises();

    // Open create form via header button.
    await wrapper.find(".view-header button").trigger("click");

    // Submit empty form -> client-side validation error.
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Please describe what you want to produce.");
    expect(postMock).not.toHaveBeenCalled();

    // Fill in and submit -> API error is shown, no navigation.
    const textareas = wrapper.findAll("textarea");
    await textareas[0]!.setValue("A story about numbers");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("request is required");
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("C7.8 Plan detail view (/app/projects/:id/plans/:planId)", () => {
  it("shows plan request, status, and meta information", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/production-plans/plan_1")
          return Promise.resolve(mockPlanRow);
        return Promise.reject(new Error(`Unknown path: ${path}`));
      }),
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    expect(wrapper.text()).toContain("Make a 30-second episode about colors");
    expect(wrapper.text()).toContain("planning");
    expect(wrapper.text()).toContain("Target: 30 sec");
    expect(wrapper.text()).toContain("Run AI Production");
    expect(wrapper.text()).toContain("Full pipeline");
  });

  it("sends the full-pipeline orchestration request and refreshes the plan", async () => {
    const postMock = vi.fn().mockResolvedValue(mockReport);
    let planGetCount = 0;
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/production-plans/plan_1") {
          planGetCount += 1;
          return Promise.resolve(planGetCount === 1 ? mockPlanRow : mockFullPlanRow);
        }
        return Promise.reject(new Error(`Unknown path: ${path}`));
      }),
      post: postMock,
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const runButton = wrapper.find("button.run-btn");
    await runButton.trigger("click");
    await flushPromises();

    // Full pipeline: no body is sent (endpoint treats omitted `to` as full run).
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(
      "/projects/proj_100/production-plans/plan_1/orchestrate",
      undefined,
      { timeout: 300_000 },
    );

    // The report is rendered stage by stage.
    expect(wrapper.text()).toContain("Orchestration Report");
    expect(wrapper.text()).toContain("completed");
    expect(wrapper.text()).toContain("Story");
    expect(wrapper.text()).toContain("3 generated");

    // The plan was re-fetched after orchestration (persisted payload shown).
    expect(planGetCount).toBe(2);
    expect(wrapper.text()).toContain("The Day Colors Went Missing");
    expect(wrapper.text()).toContain("3 planned");
  });

  it("sends the target-stage body when a stage is selected", async () => {
    const postMock = vi.fn().mockResolvedValue({
      ...mockReport,
      requestedTo: "scenes",
      stages: mockReport.stages.slice(0, 3),
    });
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockPlanRow),
      post: postMock,
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const select = wrapper.find("select");
    await select.setValue("scenes");

    const runButton = wrapper.find("button.run-btn");
    await runButton.trigger("click");
    await flushPromises();

    expect(postMock).toHaveBeenCalledWith(
      "/projects/proj_100/production-plans/plan_1/orchestrate",
      { to: "scenes" },
      { timeout: 300_000 },
    );
  });

  it("prevents duplicate orchestration submissions while a run is active", async () => {
    let resolveRun: ((value: unknown) => void) | undefined;
    const postMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockPlanRow),
      post: postMock,
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const runButton = () => wrapper.find("button.run-btn");

    await runButton().trigger("click");
    // Run is in flight: the promise has not resolved.
    expect(postMock).toHaveBeenCalledTimes(1);

    const second = runButton().trigger("click");
    await flushPromises();
    await second;
    await flushPromises();

    // No second request was issued while the first was in flight.
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(runButton().attributes("disabled")).toBeDefined();

    // Release the in-flight run; the guard resets.
    resolveRun!(mockReport);
    await flushPromises();

    expect(runButton().attributes("disabled")).toBeUndefined();
  });

  it("renders failed, partial, and not_run stage outcomes with reasons", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockPlanRow),
      post: vi.fn().mockResolvedValue({
        productionPlanId: "plan_1",
        status: "failed",
        requestedTo: null,
        stages: [
          { stage: "story", status: "completed", generated: 1 },
          { stage: "script", status: "failed", reason: "No enabled text model" },
          { stage: "scenes", status: "not_run", reason: "An earlier stage failed" },
        ],
      }),
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const runButton = wrapper.find("button.run-btn");
    await runButton.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("failed");
    expect(wrapper.text()).toContain("not_run");
    expect(wrapper.text()).toContain("What went wrong");
    expect(wrapper.text()).toContain("Script: No enabled text model");
  });

  it("renders missing tracked records and skipped-stage notes", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockPlanRow),
      post: vi.fn().mockResolvedValue({
        productionPlanId: "plan_1",
        status: "partial",
        requestedTo: null,
        stages: [
          { stage: "story", status: "skipped", skipped: 1, reason: "A valid story already exists." },
          {
            stage: "scenes",
            status: "partial",
            missingTrackedIds: ["scn_deleted"],
            reason: "Some tracked scenes no longer exist",
          },
          { stage: "shots", status: "partial", generated: 1 },
          { stage: "prompts", status: "completed", generated: 1 },
        ],
      }),
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const runButton = wrapper.find("button.run-btn");
    await runButton.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("partial");
    expect(wrapper.text()).toContain("Missing records (not recreated)");
    expect(wrapper.text()).toContain("Scenes: 1 planned record(s) no longer exist.");
    expect(wrapper.text()).toContain("Kept as-is");
    expect(wrapper.text()).toContain("Story: 1 item(s) already complete and kept as-is.");
  });

  it("shows the conflict message when a run is already in progress (409)", async () => {
    const { ApiError } = await import("@icooro/shared");
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockPlanRow),
      post: vi.fn().mockRejectedValue(
        new ApiError(
          "An orchestration is already in progress for this production plan.",
          "CONFLICT",
          409,
        ),
      ),
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const runButton = wrapper.find("button.run-btn");
    await runButton.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain(
      "An orchestration is already in progress for this production plan.",
    );
  });

  it("shows a generic fallback message on unexpected errors without leaking internals", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue(mockPlanRow),
      post: vi.fn().mockRejectedValue(new Error("TRIPWIRE: internal stack detail xyz")),
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const runButton = wrapper.find("button.run-btn");
    await runButton.trigger("click");
    await flushPromises();

    // The raw internal error text is NOT shown.
    expect(wrapper.text()).not.toContain("TRIPWIRE");
    expect(wrapper.text()).not.toContain("stack detail");
    // A friendly fallback is shown instead.
    expect(wrapper.text()).toContain("could not be started");
  });

  it("shows results overview with navigation links to existing workspace views", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/projects/proj_100/production-plans/plan_1")
          return Promise.resolve(mockFullPlanRow);
        return Promise.reject(new Error(`Unknown path: ${path}`));
      }),
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    expect(wrapper.text()).toContain("The Day Colors Went Missing");
    expect(wrapper.text()).toContain("Mozy, Mimi");
    expect(wrapper.text()).toContain("3 planned");
    expect(wrapper.text()).toContain("2 of 3 ready");
    const links = wrapper.findAll("a").map((a) => a.attributes("href"));
    expect(links).toContain("/app/projects/proj_100/story");
    expect(links).toContain("/app/projects/proj_100/episodes");
    expect(links).toContain("/app/projects/proj_100/scenes");
    expect(links).toContain("/app/projects/proj_100/shots");
  });

  it("disables orchestration for non-planning plans and explains why", async () => {
    (globalThis as any).useApi = () => ({
      get: vi.fn().mockResolvedValue({ ...mockPlanRow, status: "approved" }),
    });

    const DetailView = (await import("../pages/app/projects/[id]/plans/[planId].vue")).default;
    const wrapper = mount(DetailView as any, { global: commonGlobal });
    await flushPromises();

    const runButton = wrapper.find("button.run-btn");
    expect(runButton.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("This plan is approved. Orchestration runs only while the plan is in planning.");
  });

  it("uses the shared OrchestrationReport contract for report rendering", async () => {
    // The shared package carries the runtime contract constants...
    const shared = (await import("@icooro/shared")) as unknown as Record<string, unknown>;
    expect(shared.PRODUCTION_PLAN_TARGET_DURATION).toEqual({ min: 1, max: 3600 });
    expect(shared.PRODUCTION_PLAN_ORCHESTRATION_STAGES).toBeDefined();
    // ...and the report TYPES (erased at runtime) type the composable's
    // state: a report shaped exactly like the shared contract must be
    // assignable to the composable's report ref.
    const typedReport: import("@icooro/shared").OrchestrationReport = {
      productionPlanId: "plan_1",
      status: "partial",
      requestedTo: "shots",
      stages: [
        {
          stage: "shots",
          status: "partial",
          generated: 1,
          missingTrackedIds: ["shot_gone"],
          reason: "Some tracked shots no longer exist",
        },
      ],
      plan: null,
    };
    const { useProductionPlans } = await import("../composables/useProductionPlans");
    const state = useProductionPlans();
    state.report.value = typedReport;
    expect(state.report.value?.stages[0]?.missingTrackedIds).toEqual(["shot_gone"]);
  });
});
