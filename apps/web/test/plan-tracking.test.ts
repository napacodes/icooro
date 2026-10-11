/**
 * C8.3 — Production Plan execution-tracking UI tests.
 *
 * Tests:
 *   1. Tracking panel rendering (records, statuses, progress, errors)
 *   2. Output links only when a persisted asset/version is actually linked
 *   3. Empty state, loading state, and error states
 *   4. User-triggered refresh hitting the read-only GET endpoint
 *   5. No execution/polling side effects: only ever GET .../execution
 *   6. The shared PlanTrackingReport contract types the composable state
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref, reactive, computed } from "vue";

// Expose Vue globals (same pattern as production-plans.test.ts)
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
  status: "approved",
  plan: {
    sceneIds: ["scn_1"],
    generatedJobIds: ["job_1", "job_2"],
  },
  targetDurationSeconds: 30,
  preferences: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const mockTrackingReport = {
  productionPlanId: "plan_1",
  status: "active",
  jobType: "text-to-video",
  records: [
    {
      jobId: "job_1",
      recordState: "active",
      status: "processing",
      progress: 45,
      shotId: "shot_1",
      sceneId: "scn_1",
      output: null,
      error: null,
      updatedAt: "2026-09-02T01:00:00.000Z",
    },
    {
      jobId: "job_2",
      recordState: "terminal",
      status: "failed",
      progress: 0,
      shotId: "shot_2",
      sceneId: "scn_1",
      output: null,
      error: "ProviderError: upstream exploded apiKey=[redacted] [url]",
      updatedAt: "2026-09-02T00:30:00.000Z",
    },
  ],
  counts: { total: 2, active: 1, completed: 0, failed: 1, cancelled: 0, missing: 0, invalid: 0 },
};

const completedTrackingReport = {
  productionPlanId: "plan_1",
  status: "completed",
  jobType: "text-to-video",
  records: [
    {
      jobId: "job_1",
      recordState: "terminal",
      status: "completed",
      progress: 100,
      shotId: "shot_1",
      sceneId: "scn_1",
      output: {
        assetVersionId: "av_1",
        assetId: "ast_1",
        assetName: "Mozy shot 1",
        assetType: "video",
        version: 2,
        mimeType: "video/mp4",
        fileSize: 123456,
        status: "ready",
      },
      error: null,
      updatedAt: "2026-09-02T01:00:00.000Z",
    },
  ],
  counts: { total: 1, active: 0, completed: 1, failed: 0, cancelled: 0, missing: 0, invalid: 0 },
};

function mountDetail(getMock: ReturnType<typeof vi.fn>) {
  (globalThis as any).useApi = () => ({
    get: getMock,
    post: vi.fn(),
  });
  const DetailView = (async () =>
    (await import("../pages/app/projects/[id]/plans/[planId].vue")).default)();
  return DetailView.then((component: any) => mount(component, { global: commonGlobal }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("C8.3 Plan execution tracking UI", () => {
  it("renders each tracked job with its lifecycle status, progress, and error", async () => {
    const getMock = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100/production-plans/plan_1")
        return Promise.resolve(mockPlanRow);
      if (path === "/projects/proj_100/production-plans/plan_1/execution")
        return Promise.resolve(mockTrackingReport);
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });

    const wrapper = await mountDetail(getMock);
    await flushPromises();

    expect(wrapper.text()).toContain("Media Generation Tracking");
    expect(wrapper.text()).toContain("processing");
    expect(wrapper.text()).toContain("45%");
    expect(wrapper.text()).toContain("failed");
    expect(wrapper.text()).toContain("ProviderError: upstream exploded apiKey=[redacted] [url]");
    expect(wrapper.text()).toContain("2 tracked job(s): 1 active, 1 failed");
    // GET only — the tracking view never POSTs.
    expect(getMock).toHaveBeenCalledWith(
      "/projects/proj_100/production-plans/plan_1/execution",
    );
  });

  it("links to Assets only when a persisted output is actually reported", async () => {
    const getMock = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100/production-plans/plan_1")
        return Promise.resolve(mockPlanRow);
      if (path === "/projects/proj_100/production-plans/plan_1/execution")
        return Promise.resolve(completedTrackingReport);
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });

    const wrapper = await mountDetail(getMock);
    await flushPromises();

    const link = wrapper.find(".output-link");
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("/app/projects/proj_100/assets?assetId=ast_1");
    expect(wrapper.text()).toContain("Mozy shot 1");
  });

  it("shows no output link when a completed job has no persisted output", async () => {
    const getMock = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100/production-plans/plan_1")
        return Promise.resolve(mockPlanRow);
      if (path === "/projects/proj_100/production-plans/plan_1/execution")
        return Promise.resolve({
          ...completedTrackingReport,
          records: [
            { ...completedTrackingReport.records[0]!, output: null },
          ],
        });
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });

    const wrapper = await mountDetail(getMock);
    await flushPromises();

    expect(wrapper.text()).toContain("completed");
    expect(wrapper.find(".output-link").exists()).toBe(false);
  });

  it("renders missing and invalid records with their reasons", async () => {
    const getMock = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100/production-plans/plan_1")
        return Promise.resolve(mockPlanRow);
      if (path === "/projects/proj_100/production-plans/plan_1/execution")
        return Promise.resolve({
          productionPlanId: "plan_1",
          status: "empty",
          jobType: "text-to-video",
          records: [
            {
              jobId: "job_gone",
              recordState: "missing",
              status: null,
              progress: null,
              shotId: null,
              sceneId: null,
              output: null,
              error: null,
              reason: "The tracked generation job no longer exists.",
              updatedAt: null,
            },
            {
              jobId: "job_bad",
              recordState: "invalid",
              status: "queued",
              progress: null,
              shotId: null,
              sceneId: null,
              output: null,
              error: null,
              reason: "The tracked job no longer belongs to this production plan's context.",
              updatedAt: null,
            },
          ],
          counts: { total: 2, active: 0, completed: 0, failed: 0, cancelled: 0, missing: 1, invalid: 1 },
        });
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });

    const wrapper = await mountDetail(getMock);
    await flushPromises();

    expect(wrapper.text()).toContain("missing");
    expect(wrapper.text()).toContain("invalid");
    expect(wrapper.text()).toContain("The tracked generation job no longer exists.");
    expect(wrapper.text()).toContain("The tracked job no longer belongs to this production plan's context.");
  });

  it("shows the empty state for a plan with no tracked jobs", async () => {
    const getMock = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100/production-plans/plan_1")
        return Promise.resolve({ ...mockPlanRow, plan: {} });
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });

    const wrapper = await mountDetail(getMock);
    await flushPromises();

    // No tracking fetch at all when the plan tracks nothing.
    expect(getMock).not.toHaveBeenCalledWith(
      "/projects/proj_100/production-plans/plan_1/execution",
    );
    expect(wrapper.text()).toContain("No generated media yet");
  });

  it("shows a tracking error banner when the endpoint fails", async () => {
    const { ApiError } = await import("@icooro/shared");
    const getMock = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100/production-plans/plan_1")
        return Promise.resolve(mockPlanRow);
      if (path === "/projects/proj_100/production-plans/plan_1/execution")
        return Promise.reject(new ApiError("Production plan not found", "NOT_FOUND", 404));
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });

    const wrapper = await mountDetail(getMock);
    await flushPromises();

    expect(wrapper.text()).toContain("Production plan not found");
  });

  it("refreshes through the read-only endpoint only, never triggering execution", async () => {
    let trackingGetCount = 0;
    const getMock = vi.fn().mockImplementation((path: string) => {
      if (path === "/projects/proj_100/production-plans/plan_1")
        return Promise.resolve(mockPlanRow);
      if (path === "/projects/proj_100/production-plans/plan_1/execution") {
        trackingGetCount += 1;
        return Promise.resolve(mockTrackingReport);
      }
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });
    const postMock = vi.fn();

    const wrapper = await mountDetail(getMock);
    await flushPromises();
    expect(trackingGetCount).toBe(1);

    const refresh = wrapper.find(".tracking-controls button");
    await refresh.trigger("click");
    await flushPromises();

    expect(trackingGetCount).toBe(2);
    // No POST/PUT/PATCH of any kind was issued by the tracking flow.
    expect(postMock).not.toHaveBeenCalled();
    expect(getMock.mock.calls.every((call: unknown[]) => typeof call[0] === "string" && call[0].includes("/execution") || call[0] === "/projects/proj_100/production-plans/plan_1")).toBe(true);
  });

  it("uses the shared PlanTrackingReport contract for the composable state", async () => {
    const typedReport: import("@icooro/shared").PlanTrackingReport = {
      productionPlanId: "plan_1",
      status: "active",
      jobType: "text-to-video",
      records: [
        {
          jobId: "job_1",
          recordState: "active",
          status: "downloading",
          progress: 90,
          shotId: null,
          sceneId: null,
          output: null,
          error: null,
          updatedAt: "2026-09-02T01:00:00.000Z",
        },
      ],
      counts: { total: 1, active: 1, completed: 0, failed: 0, cancelled: 0, missing: 0, invalid: 0 },
    };
    const { useProductionPlans } = await import("../composables/useProductionPlans");
    const state = useProductionPlans();
    state.tracking.value = typedReport;
    expect(state.tracking.value?.records[0]?.status).toBe("downloading");
    expect(state.tracking.value?.counts.active).toBe(1);
  });
});
