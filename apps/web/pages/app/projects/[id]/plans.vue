<template>
  <div class="plans-view">
    <div class="view-header">
      <div>
        <h2>Production Plans</h2>
        <p class="view-subtitle">
          AI-assisted planning drafts. Orchestration plans and generates story, script, scenes,
          shots and prompts — review and approval always stay with you.
        </p>
      </div>
      <BaseButton variant="secondary" size="sm" @click="showForm = !showForm">
        {{ showForm ? "Close Form" : "New Plan" }}
      </BaseButton>
    </div>

    <LoadingState v-if="loading && plans.length === 0" label="Loading production plans…" />
    <ErrorBanner v-else-if="error && plans.length === 0" :message="error" />

    <template v-else>
      <!-- Create plan -->
      <BasePanel
        v-if="showForm"
        title="New Production Plan"
        description="Describe the episode you want. Orchestration will draft the story, script, scenes, shots and prompts."
        class="create-panel"
      >
        <form class="plan-form" @submit.prevent="onCreatePlan">
          <BaseTextarea
            v-model="form.request"
            label="Production Request"
            :rows="3"
            :maxlength="4000"
            required
            placeholder="e.g. Make a 30-second episode teaching children the three primary colors"
          />
          <BaseInput
            v-model="form.targetDuration"
            label="Target Duration (seconds, optional)"
            type="number"
            :min="1"
            :max="3600"
            placeholder="30"
          />
          <BaseTextarea
            v-model="form.preferenceNotes"
            label="Preferences (optional)"
            :rows="2"
            :maxlength="2000"
            placeholder="Tone, audience, constraints…"
          />
          <ErrorBanner v-if="formError" :message="formError" />
          <div class="form-actions">
            <BaseButton type="submit" variant="primary" :loading="creating">
              Create Plan
            </BaseButton>
          </div>
        </form>
      </BasePanel>

      <!-- Plans list -->
      <EmptyState
        v-if="plans.length === 0"
        title="No production plans yet"
        description="Create your first plan to start AI-assisted planning for this project."
      >
        <BaseButton variant="primary" @click="openCreateForm">Create a Plan</BaseButton>
      </EmptyState>

      <div v-else class="cards-grid">
        <BaseCard
          v-for="item in plans"
          :key="item.id"
          class="plan-card"
        >
          <div class="card-header">
            <h3 class="plan-request">{{ item.request }}</h3>
            <StatusPill :tone="statusTone(item.status)">{{ formatStatus(item.status) }}</StatusPill>
          </div>
          <dl class="plan-meta">
            <div v-if="item.targetDurationSeconds" class="meta-row">
              <dt>Target duration</dt>
              <dd>{{ formatDuration(item.targetDurationSeconds) }}</dd>
            </div>
            <div class="meta-row">
              <dt>Created</dt>
              <dd>{{ formatDate(item.createdAt) }}</dd>
            </div>
            <div class="meta-row">
              <dt>Updated</dt>
              <dd>{{ formatDate(item.updatedAt) }}</dd>
            </div>
          </dl>
          <div class="card-actions">
            <NuxtLink :to="`/app/projects/${projectId}/plans/${item.id}`" class="open-link">
              <BaseButton size="sm" variant="secondary">Open Plan</BaseButton>
            </NuxtLink>
          </div>
        </BaseCard>
      </div>

      <ErrorBanner v-if="error && plans.length > 0" :message="error" tone="warning" />
      <div v-if="refreshing" class="refresh-note">
        <LoadingState label="Refreshing plans…" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  apiErrorMessage,
  useProductionPlans,
} from "../../../../composables/useProductionPlans";
import { statusTone } from "../../../../composables/useStatusTone";

const router = useRouter();
const {
  plans,
  loading,
  creating,
  error,
  refreshing,
  projectId,
  loadPlans,
  createPlan,
  updateTargetDuration,
} = useProductionPlans();

const showForm = ref(false);
const formError = ref<string | null>(null);

const form = reactive({
  request: "",
  targetDuration: "",
  preferenceNotes: "",
});

function openCreateForm() {
  showForm.value = true;
}

function formatStatus(status: string): string {
  return (status || "").replace(/_/g, " ");
}

function formatDuration(seconds: number): string {
  if (seconds % 60 === 0 && seconds > 0) {
    const minutes = seconds / 60;
    return `${minutes} min`;
  }
  return `${seconds} sec`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function onCreatePlan() {
  formError.value = null;
  const request = form.request.trim();
  if (!request) {
    formError.value = "Please describe what you want to produce.";
    return;
  }

  let seconds: number | null = null;
  if (form.targetDuration.trim().length > 0) {
    seconds = Number(form.targetDuration);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
      formError.value = "Target duration must be a whole number of seconds between 1 and 3600.";
      return;
    }
  }

  try {
    const created = await createPlan({
      request,
      preferenceNotes: form.preferenceNotes.trim() || undefined,
    });
    if (seconds !== null) {
      await updateTargetDuration(created.id, seconds);
    }
    form.request = "";
    form.targetDuration = "";
    form.preferenceNotes = "";
    showForm.value = false;
    await router.push(`/app/projects/${projectId.value}/plans/${created.id}`);
  } catch (err: unknown) {
    formError.value = apiErrorMessage(err, "Failed to create the production plan. Please try again.");
  }
}

onMounted(loadPlans);
</script>

<style scoped>
.plans-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 1rem;
}

.view-header h2 {
  margin: 0;
  font-size: 1.4rem;
  color: #17212b;
}

.view-subtitle {
  margin: 0.25rem 0 0;
  color: #68777c;
  font-size: 0.9rem;
  max-width: 640px;
}

.plan-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-actions {
  display: flex;
  gap: 0.75rem;
}

.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1rem;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
}

.plan-request {
  margin: 0;
  font-size: 1rem;
  color: #17212b;
  overflow-wrap: anywhere;
}

.plan-meta {
  margin: 0.75rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.meta-row {
  display: flex;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.meta-row dt {
  color: #68777c;
  min-width: 8.5rem;
}

.meta-row dd {
  margin: 0;
  color: #435458;
}

.card-actions {
  margin-top: 0.9rem;
}

.open-link {
  text-decoration: none;
}

.refresh-note {
  display: flex;
  justify-content: center;
}
</style>
