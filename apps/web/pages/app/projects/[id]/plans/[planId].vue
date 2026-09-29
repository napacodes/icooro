<template>
  <div class="plan-detail-view">
    <nav class="breadcrumb-nav" aria-label="Breadcrumbs">
      <NuxtLink :to="`/app/projects/${projectId}/plans`" class="back-link">
        ← Production Plans
      </NuxtLink>
    </nav>

    <LoadingState v-if="loading && !plan" label="Loading production plan…" />
    <ErrorBanner
      v-else-if="error && !plan"
      :message="error"
      retry-label="Retry"
      @retry="loadPlan"
    />

    <template v-else-if="plan">
      <header class="plan-header">
        <div>
          <h2 class="plan-request">{{ plan.request }}</h2>
          <p class="plan-meta-line">
            <StatusPill :tone="statusTone(plan.status)">{{ formatStatus(plan.status) }}</StatusPill>
            <span v-if="plan.targetDurationSeconds" class="meta-item">
              Target: {{ formatDuration(plan.targetDurationSeconds) }}
            </span>
            <span class="meta-item">Created {{ formatDate(plan.createdAt) }}</span>
            <span class="meta-item">Updated {{ formatDate(plan.updatedAt) }}</span>
          </p>
        </div>
      </header>

      <!-- Orchestration controls -->
      <BasePanel
        title="AI Production Pipeline"
        description="Runs the remaining planning stages in order: story, script, scenes, shots, prompts. Existing work is kept — nothing is regenerated. The plan stays in planning; review and approval remain yours."
        class="orchestration-panel"
      >
        <div class="orchestration-controls">
          <div class="stage-select-wrap">
            <span class="stage-select-label">Run up to (optional)</span>
            <BaseSelect
              v-model="targetStage"
              :options="stageOptions"
              placeholder="Full pipeline"
              class="stage-select"
            />
          </div>
          <BaseButton
            class="run-btn"
            variant="primary"
            :loading="orchestrating"
            :disabled="orchestrating || !canOrchestrate"
            @click="onOrchestrate"
          >
            {{ orchestrating ? "Running AI production…" : "Run AI Production" }}
          </BaseButton>
        </div>
        <p v-if="!canOrchestrate" class="orchestration-note is-warning">
          This plan is {{ formatStatus(plan.status) }}. Orchestration runs only while the plan is in
          planning.
        </p>
        <p v-else class="orchestration-note">
          This only plans the episode. It does not generate media or approve the plan.
        </p>
        <ErrorBanner v-if="orchestrationError" :message="orchestrationError" />

        <!-- Stage-by-stage report -->
        <div v-if="report" class="orchestration-report" role="status">
          <div class="report-header">
            <h3>Orchestration Report</h3>
            <StatusPill :tone="reportTone(report.status)">{{ report.status }}</StatusPill>
          </div>

          <ul class="stage-list">
            <li
              v-for="stage in report.stages"
              :key="stage.stage"
              class="stage-row"
            >
              <span class="stage-name">{{ stageLabel(stage.stage) }}</span>
              <StatusPill :tone="stageTone(stage.status)">{{ stage.status }}</StatusPill>
              <span v-if="typeof stage.generated === 'number'" class="stage-count">
                {{ stage.generated }} generated
              </span>
              <span v-if="typeof stage.skipped === 'number'" class="stage-count">
                {{ stage.skipped }} kept
              </span>
            </li>
          </ul>

          <div v-if="failureReasons.length > 0" class="report-detail">
            <h4>What went wrong</h4>
            <ul>
              <li v-for="(reason, index) in failureReasons" :key="index">{{ reason }}</li>
            </ul>
          </div>

          <div v-if="missingNotes.length > 0" class="report-detail">
            <h4>Missing records (not recreated)</h4>
            <ul>
              <li v-for="(note, index) in missingNotes" :key="index">{{ note }}</li>
            </ul>
            <p class="report-hint">
              Manually deleted scenes or shots are never recreated automatically. Use the Scenes or
              Shots sections to regenerate them explicitly if needed.
            </p>
          </div>

          <div v-if="skippedNotes.length > 0" class="report-detail">
            <h4>Kept as-is</h4>
            <ul>
              <li v-for="(note, index) in skippedNotes" :key="index">{{ note }}</li>
            </ul>
          </div>
        </div>
      </BasePanel>

      <!-- Generated results overview -->
      <BasePanel
        title="Planned Content"
        description="What this plan has produced so far. Review and edit each part in its workspace section."
      >
        <div v-if="refreshing" class="refresh-note">
          <LoadingState label="Refreshing plan…" />
        </div>
        <div class="results-grid">
          <div class="result-block">
            <h4>Story</h4>
            <template v-if="story">
              <p class="result-title">{{ story.title }}</p>
              <p class="result-text">{{ story.premise }}</p>
              <p class="result-characters">
                Characters: {{ (story.characters || []).join(", ") || "—" }}
              </p>
            </template>
            <p v-else class="result-empty">Not generated yet.</p>
            <NuxtLink :to="`/app/projects/${projectId}/story`" class="result-link">
              Review in Story →
            </NuxtLink>
          </div>

          <div class="result-block">
            <h4>Script</h4>
            <template v-if="scriptVersionId">
              <p class="result-title">Script version ready</p>
              <p class="result-text">Episode {{ episodeLabel }} — script drafted and versioned.</p>
            </template>
            <p v-else class="result-empty">Not generated yet.</p>
            <NuxtLink :to="`/app/projects/${projectId}/episodes`" class="result-link">
              Review in Episodes →
            </NuxtLink>
          </div>

          <div class="result-block">
            <h4>Scenes</h4>
            <p class="result-count">{{ sceneCount }} planned</p>
            <p class="result-text">
              {{ sceneCount > 0 ? "Scene list generated for this plan." : "No scenes yet." }}
            </p>
            <NuxtLink :to="`/app/projects/${projectId}/scenes`" class="result-link">
              Review in Scenes →
            </NuxtLink>
          </div>

          <div class="result-block">
            <h4>Shots</h4>
            <p class="result-count">{{ shotCount }} planned</p>
            <p class="result-text">
              {{ shotCount > 0 ? "Shot lists generated for the planned scenes." : "No shots yet." }}
            </p>
            <NuxtLink :to="`/app/projects/${projectId}/shots`" class="result-link">
              Review in Shots →
            </NuxtLink>
          </div>

          <div class="result-block">
            <h4>Prompts</h4>
            <p class="result-count">{{ promptedCount }} of {{ shotCount }} ready</p>
            <p class="result-text">
              {{
                promptedCount >= shotCount && shotCount > 0
                  ? "Every planned shot has a media prompt."
                  : "Media prompts are written for planned shots."
              }}
            </p>
            <NuxtLink :to="`/app/projects/${projectId}/shots`" class="result-link">
              Review in Shots →
            </NuxtLink>
          </div>
        </div>
      </BasePanel>

      <ErrorBanner v-if="error && plan" :message="error" tone="warning" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { statusTone } from "../../../../../composables/useStatusTone";
import {
  PRODUCTION_PLAN_ORCHESTRATION_STAGES,
  type ProductionPlanOrchestrationStage,
} from "@icooro/shared";
import {
  apiErrorMessage,
  ORCHESTRATION_STAGE_LABELS,
  payloadPromptedShotIds,
  payloadSceneIds,
  payloadShotIdsByScene,
  payloadStory,
  payloadString,
  useProductionPlans,
} from "../../../../../composables/useProductionPlans";

const {
  plan,
  loading,
  refreshing,
  orchestrating,
  error,
  report,
  projectId,
  planId,
  loadPlan,
  orchestratePlan,
} = useProductionPlans();

const targetStage = ref("");
const orchestrationError = ref<string | null>(null);

const stageOptions = PRODUCTION_PLAN_ORCHESTRATION_STAGES.map((stage) => ({
  value: stage,
  label: ORCHESTRATION_STAGE_LABELS[stage],
}));

/** Orchestration runs only while the plan is in planning status. */
const canOrchestrate = computed(() => plan.value?.status === "planning");

const story = computed(() => {
  const payload = plan.value ? payloadStory(plan.value.plan ?? {}) : null;
  if (!payload) return null;
  return {
    title: payloadString(payload, "title"),
    premise: payloadString(payload, "premise"),
    characters: Array.isArray(payload.characters)
      ? payload.characters.filter((c): c is string => typeof c === "string")
      : [],
  };
});

const scriptVersionId = computed(() =>
  plan.value ? payloadString(plan.value.plan ?? {}, "scriptVersionId") : null,
);

const episodeId = computed(() =>
  plan.value ? payloadString(plan.value.plan ?? {}, "episodeId") : null,
);

const episodeLabel = computed(() => (episodeId.value ? episodeId.value.slice(0, 8) : "—"));

const sceneCount = computed(() =>
  plan.value ? payloadSceneIds(plan.value.plan ?? {}).length : 0,
);

const shotCount = computed(() => {
  if (!plan.value) return 0;
  const byScene = payloadShotIdsByScene(plan.value.plan ?? {});
  return Object.values(byScene).reduce((sum, ids) => sum + ids.length, 0);
});

const promptedCount = computed(() =>
  plan.value ? payloadPromptedShotIds(plan.value.plan ?? {}).length : 0,
);

const failureReasons = computed(() =>
  report.value
    ? report.value.stages
        .filter((s) => s.status === "failed")
        .map((s) => `${ORCHESTRATION_STAGE_LABELS[s.stage]}: ${s.reason || "Stage failed."}`)
    : [],
);

const missingNotes = computed(() => {
  if (!report.value) return [];
  const notes: string[] = [];
  for (const stage of report.value.stages) {
    if (!stage.missingTrackedIds || stage.missingTrackedIds.length === 0) continue;
    notes.push(
      `${ORCHESTRATION_STAGE_LABELS[stage.stage]}: ${stage.missingTrackedIds.length} planned record(s) no longer exist.`,
    );
  }
  return notes;
});

const skippedNotes = computed(() => {
  if (!report.value) return [];
  return report.value.stages
    .filter((s) => s.status === "skipped")
    .map((s) => {
      const kept = typeof s.skipped === "number" ? `${s.skipped} item(s) ` : "";
      return `${ORCHESTRATION_STAGE_LABELS[s.stage]}: ${kept}already complete and kept as-is.`;
    });
});

function stageLabel(stage: ProductionPlanOrchestrationStage): string {
  return ORCHESTRATION_STAGE_LABELS[stage] ?? stage;
}

function formatStatus(status: string): string {
  return (status || "").replace(/_/g, " ");
}

function formatDuration(seconds: number): string {
  if (seconds % 60 === 0 && seconds > 0) return `${seconds / 60} min`;
  return `${seconds} sec`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function reportTone(status: string): "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "partial") return "warning";
  return "danger";
}

function stageTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "completed":
    case "approved":
      return "success";
    case "skipped":
    case "ready_for_review":
      return "info";
    case "partial":
    case "planning":
      return "warning";
    case "failed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Runs orchestration with duplicate-submission protection: the button is
 * disabled and loading while `orchestrating` is true, and this handler
 * returns immediately if a run is somehow already active. Afterward the
 * plan (and its persisted payload) is re-fetched so the results overview
 * reflects the database, not just the response.
 */
async function onOrchestrate() {
  if (orchestrating.value) return;
  orchestrationError.value = null;
  const to = targetStage.value ? (targetStage.value as ProductionPlanOrchestrationStage) : undefined;
  try {
    await orchestratePlan(planId.value, to);
    await loadPlan({ silent: true });
  } catch (err: unknown) {
    orchestrationError.value = apiErrorMessage(
      err,
      "The AI production run could not be started. Please try again in a moment.",
    );
  }
}

onMounted(() => loadPlan());
</script>

<style scoped>
.plan-detail-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.breadcrumb-nav {
  margin-bottom: 0.25rem;
}

.back-link {
  color: #176b65;
  font-weight: 600;
  text-decoration: none;
  font-size: 0.95rem;
}

.back-link:hover {
  text-decoration: underline;
}

.plan-header h2 {
  margin: 0;
  font-size: 1.3rem;
  color: #17212b;
  overflow-wrap: anywhere;
}

.plan-meta-line {
  margin: 0.5rem 0 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  color: #68777c;
  font-size: 0.85rem;
}

.meta-item {
  white-space: nowrap;
}

.orchestration-controls {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
  flex-wrap: wrap;
}

.stage-select-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.stage-select-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #52606d;
}

.stage-select {
  max-width: 260px;
}

.orchestration-note {
  margin: 0.75rem 0 0;
  font-size: 0.85rem;
  color: #68777c;
}

.orchestration-note.is-warning {
  color: #8a5a00;
  font-weight: 600;
}

.orchestration-report {
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid #e1ebe9;
}

.report-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.report-header h3 {
  margin: 0;
  font-size: 1rem;
  color: #17212b;
}

.stage-list {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.stage-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.stage-name {
  min-width: 6rem;
  font-weight: 600;
  color: #17212b;
}

.stage-count {
  font-size: 0.8rem;
  color: #68777c;
}

.report-detail {
  margin-top: 0.9rem;
}

.report-detail h4 {
  margin: 0 0 0.3rem;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #176b65;
}

.report-detail ul {
  margin: 0;
  padding-left: 1.1rem;
  color: #435458;
  font-size: 0.88rem;
}

.report-hint {
  margin: 0.4rem 0 0;
  font-size: 0.8rem;
  color: #68777c;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}

.result-block {
  border: 1px solid #e1ebe9;
  border-radius: 6px;
  padding: 0.9rem;
  background: #fbfdfd;
}

.result-block h4 {
  margin: 0 0 0.4rem;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #176b65;
}

.result-title {
  margin: 0;
  font-weight: 700;
  color: #17212b;
}

.result-count {
  margin: 0;
  font-weight: 700;
  font-size: 1.2rem;
  color: #17212b;
}

.result-text {
  margin: 0.3rem 0 0;
  font-size: 0.85rem;
  color: #556968;
}

.result-characters {
  margin: 0.3rem 0 0;
  font-size: 0.8rem;
  color: #68777c;
}

.result-empty {
  margin: 0;
  font-size: 0.85rem;
  color: #8fa0a5;
  font-style: italic;
}

.result-link {
  display: inline-block;
  margin-top: 0.6rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: #176b65;
  text-decoration: none;
}

.result-link:hover {
  text-decoration: underline;
}

.refresh-note {
  display: flex;
  justify-content: center;
  margin-bottom: 0.75rem;
}
</style>
