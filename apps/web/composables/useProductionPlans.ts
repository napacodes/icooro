import { computed, ref, type ComputedRef, type Ref } from "vue";
import { ApiError, type ProductionPlanOrchestrationStage } from "@icooro/shared";

/**
 * useProductionPlans — C7.8 frontend state for the Production Plans area.
 *
 * Talks to the existing C7.1 plan endpoints and the C7.7 orchestration
 * endpoint through the shared `useApi` wrapper. This composable owns
 * presentation state only: all generated content lives in the backend
 * (plan payload, episodes, scenes, shots) and is re-fetched — never
 * duplicated into a parallel frontend store.
 *
 * Response types mirror the API's actual contracts:
 * - Plan rows come from the C7.1 CRUD endpoints (production_plans table row).
 * - `OrchestrationReport` mirrors the C7.7 service's report (no shared type
 *   exists for the report yet — the request side IS shared:
 *   `orchestratePlanSchema` / `PRODUCTION_PLAN_ORCHESTRATION_STAGES`).
 */

/** One production plan row, as returned by the C7.1 endpoints. */
export interface ProductionPlan {
  id: string;
  projectId: string;
  episodeId: string | null;
  request: string;
  status: string;
  plan: Record<string, unknown> | null;
  targetDurationSeconds: number | null;
  preferences: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** The stages of the C7.7 pipeline, in orchestration order. */
export const ORCHESTRATION_STAGE_LABELS: Readonly<
  Record<ProductionPlanOrchestrationStage, string>
> = {
  story: "Story",
  script: "Script",
  scenes: "Scenes",
  shots: "Shots",
  prompts: "Prompts",
};

/** Per-stage outcome of one orchestration run (C7.7 report row). */
export interface OrchestrationStageReport {
  stage: ProductionPlanOrchestrationStage;
  status: "completed" | "skipped" | "partial" | "failed" | "not_run";
  reason?: string | undefined;
  generated?: number | undefined;
  skipped?: number | undefined;
  missingTrackedIds?: string[] | undefined;
}

/** The full C7.7 orchestration response payload. */
export interface OrchestrationReport {
  productionPlanId: string;
  status: "completed" | "partial" | "failed";
  requestedTo: ProductionPlanOrchestrationStage | null;
  stages: OrchestrationStageReport[];
  plan: Record<string, unknown> | null;
}

/**
 * Returns a user-facing message for a caught request error. `ApiError`
 * messages come from the API and are safe to show verbatim; anything else
 * (network failures, unexpected internals) is masked behind `fallback` so
 * stack details or provider credentials can never reach the UI.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return fallback;
}

/** True when `value` is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract a well-formed string array from an unknown payload value. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export interface CreateProductionPlanUiInput {
  request: string;
  targetDurationSeconds?: number | null | undefined;
  /** Free-form notes stored in the plan's opaque `preferences` record. */
  preferenceNotes?: string | undefined;
}

export interface UseProductionPlansState {
  plans: Ref<ProductionPlan[]>;
  plan: Ref<ProductionPlan | null>;
  loading: Ref<boolean>;
  refreshing: Ref<boolean>;
  creating: Ref<boolean>;
  orchestrating: Ref<boolean>;
  error: Ref<string | null>;
  report: Ref<OrchestrationReport | null>;
  projectId: ComputedRef<string>;
  planId: ComputedRef<string>;
  loadPlans: () => Promise<void>;
  loadPlan: (options?: { silent?: boolean }) => Promise<void>;
  createPlan: (input: CreateProductionPlanUiInput) => Promise<ProductionPlan>;
  updateTargetDuration: (planId: string, seconds: number) => Promise<ProductionPlan>;
  orchestratePlan: (
    planId: string,
    to?: ProductionPlanOrchestrationStage | undefined,
  ) => Promise<OrchestrationReport>;
}

export function useProductionPlans(): UseProductionPlansState {
  const route = useRoute();
  const api = useApi();

  const projectId = computed(() => (route.params.id as string) || "");
  const planId = computed(() => (route.params.planId as string) || "");

  const plans = ref<ProductionPlan[]>([]);
  const plan = ref<ProductionPlan | null>(null);
  const loading = ref(false);
  const refreshing = ref(false);
  const creating = ref(false);
  const orchestrating = ref(false);
  const error = ref<string | null>(null);
  const report = ref<OrchestrationReport | null>(null);

  /** Lists the current project's plans, newest first (server-ordered). */
  async function loadPlans() {
    if (!projectId.value) return;
    loading.value = true;
    error.value = null;
    try {
      const rows = await api.get<ProductionPlan[]>(
        `/projects/${projectId.value}/production-plans`,
      );
      plans.value = Array.isArray(rows) ? rows : [];
    } catch (err: any) {
      error.value = err?.message || "Failed to load production plans";
    } finally {
      loading.value = false;
    }
  }

  /**
   * Loads one plan. `silent` keeps the page content mounted while
   * refreshing (used after orchestration so users keep their place).
   */
  async function loadPlan(options: { silent?: boolean } = {}) {
    if (!projectId.value || !planId.value) return;
    if (options.silent) {
      refreshing.value = true;
    } else {
      loading.value = true;
    }
    error.value = null;
    try {
      plan.value = await api.get<ProductionPlan>(
        `/projects/${projectId.value}/production-plans/${planId.value}`,
      );
    } catch (err: any) {
      error.value = err?.message || "Failed to load production plan";
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  }

  /**
   * Creates a plan from the user's request prompt. The C7.1 create
   * endpoint accepts the request plus optional opaque preferences; the
   * optional target duration is applied through the plan-update endpoint
   * by the caller (see `updateTargetDuration`).
   */
  async function createPlan(input: CreateProductionPlanUiInput): Promise<ProductionPlan> {
    creating.value = true;
    try {
      const body: Record<string, unknown> = { request: input.request.trim() };
      if (input.preferenceNotes && input.preferenceNotes.trim().length > 0) {
        body.preferences = { notes: input.preferenceNotes.trim() };
      }
      return await api.post<ProductionPlan>(
        `/projects/${projectId.value}/production-plans`,
        body,
      );
    } finally {
      creating.value = false;
    }
  }

  /** Applies the optional target duration to an existing plan. */
  async function updateTargetDuration(planId: string, seconds: number): Promise<ProductionPlan> {
    return api.patch<ProductionPlan>(
      `/projects/${projectId.value}/production-plans/${planId}`,
      { targetDurationSeconds: seconds },
    );
  }

  /**
   * Runs the C7.7 AI production pipeline for one plan. `to` optionally
   * bounds the sequence; when omitted the full story→script→scenes→shots→
   * prompts sequence runs. The timeout is raised well above the default
   * because the endpoint is synchronous and performs several provider
   * calls. Duplicate submissions are prevented by the caller holding the
   * `orchestrating` flag (button disabled + guarded handler).
   */
  async function orchestratePlan(
    targetPlanId: string,
    to?: ProductionPlanOrchestrationStage | undefined,
  ): Promise<OrchestrationReport> {
    orchestrating.value = true;
    try {
      const result = await api.post<OrchestrationReport>(
        `/projects/${projectId.value}/production-plans/${targetPlanId}/orchestrate`,
        to ? { to } : undefined,
        { timeout: 300_000 },
      );
      report.value = result;
      return result;
    } finally {
      orchestrating.value = false;
    }
  }

  return {
    plans,
    plan,
    loading,
    refreshing,
    creating,
    orchestrating,
    error,
    report,
    projectId,
    planId,
    loadPlans,
    loadPlan,
    createPlan,
    updateTargetDuration,
    orchestratePlan,
  };
}

/** Payload helpers shared by the plan detail view. */

export function planPayloadOf(plan: ProductionPlan | null): Record<string, unknown> {
  return plan && isPlainObject(plan.plan) ? plan.plan : {};
}

export function payloadStory(payload: Record<string, unknown>): Record<string, unknown> | null {
  const story = payload.story;
  return isPlainObject(story) ? story : null;
}

export function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function payloadSceneIds(payload: Record<string, unknown>): string[] {
  return stringArray(payload.sceneIds);
}

export function payloadShotIdsByScene(payload: Record<string, unknown>): Record<string, string[]> {
  const raw = payload.shotIds;
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [sceneId, ids] of Object.entries(raw)) {
    const tracked = stringArray(ids);
    if (sceneId.length > 0 && tracked.length > 0) out[sceneId] = tracked;
  }
  return out;
}

export function payloadPromptedShotIds(payload: Record<string, unknown>): string[] {
  return stringArray(payload.promptedShotIds);
}
