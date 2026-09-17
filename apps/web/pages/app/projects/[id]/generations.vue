<template>
  <div class="generations-view">
    <div class="view-header">
      <div>
        <h2>AI Generation Jobs</h2>
        <p class="view-subtitle">Trigger generative media tasks and monitor status, progress, and result persistence.</p>
      </div>
      <BaseButton
        size="sm"
        variant="secondary"
        :loading="refreshing"
        @click="loadJobs"
      >
        Refresh Jobs
      </BaseButton>
    </div>

    <LoadingState v-if="loading" message="Loading generation jobs…" />
    <ErrorBanner
      v-else-if="error"
      :message="error"
      retry-label="Retry"
      @retry="init"
    />

    <div v-else class="generations-layout">
      <!-- Create Job Column -->
      <BasePanel
        title="New Generation Job"
        description="Submit a text-to-media prompt to configured AI providers."
        class="create-panel"
      >
        <form class="job-form" @submit.prevent="createJob">
          <BaseTextarea
            v-model="form.prompt"
            label="Generation Prompt"
            :rows="4"
            required
            placeholder="A dramatic cinematic wide shot of a futuristic neon city skyline at dusk, 4k..."
          />
          <div class="form-row">
            <BaseSelect
              v-model="form.targetMediaType"
              label="Target Media Type"
              :options="mediaTypeOptions"
            />
            <BaseSelect
              v-model="form.jobType"
              label="Job Type"
              :options="jobTypeOptions"
            />
          </div>
          <div class="form-row">
            <BaseSelect
              v-model="form.providerId"
              label="AI Provider"
              :options="providerOptions"
            />
            <BaseSelect
              v-model="form.modelId"
              label="AI Model"
              :options="modelOptions"
            />
          </div>
          <BaseButton
            type="submit"
            variant="primary"
            :loading="creating"
          >
            Create Generation Job
          </BaseButton>
        </form>
      </BasePanel>

      <!-- Jobs List Column -->
      <div class="jobs-list-container">
        <EmptyState
          v-if="jobs.length === 0"
          title="No generation jobs yet"
          description="Create your first generation job on the left to start producing AI media."
        />
        <div v-else class="jobs-grid">
          <BaseCard
            v-for="job in jobs"
            :key="job.id"
            class="job-card"
          >
            <div class="job-card-header">
              <div class="job-meta-left">
                <span class="media-type-pill" :class="job.targetMediaType">{{ job.targetMediaType }}</span>
                <StatusPill :tone="statusTone(job.status)">{{ job.status }}</StatusPill>
                <span v-if="job.progress !== null && job.progress !== undefined" class="progress-badge">
                  {{ job.progress }}%
                </span>
              </div>
              <div class="job-timestamps">
                <span class="time-text">{{ formatDate(job.createdAt) }}</span>
              </div>
            </div>

            <p class="prompt-preview">{{ job.prompt || "No prompt specified" }}</p>

            <div class="job-specs">
              <span class="spec-item">
                <strong>Provider:</strong> {{ getProviderName(job.providerId) }}
              </span>
              <span class="spec-item">
                <strong>Model:</strong> {{ getModelName(job.modelId) }}
              </span>
              <span v-if="job.assetVersionId" class="spec-item persisted-item">
                ✓ Persisted as Asset Version
              </span>
            </div>

            <div v-if="job.error" class="job-error-box">
              <span class="error-title">Error:</span>
              <p class="error-detail">{{ job.error }}</p>
            </div>

            <div class="job-actions">
              <!-- Submit -->
              <BaseButton
                v-if="job.status === 'queued'"
                size="sm"
                variant="primary"
                :loading="actionLoadingId === `${job.id}-submit`"
                @click="submitJob(job.id)"
              >
                Submit to Provider
              </BaseButton>

              <!-- Poll -->
              <BaseButton
                v-if="job.status === 'submitted' || job.status === 'processing'"
                size="sm"
                variant="secondary"
                :loading="actionLoadingId === `${job.id}-poll`"
                @click="pollJob(job.id)"
              >
                Check / Poll Status
              </BaseButton>

              <!-- Cancel -->
              <BaseButton
                v-if="['queued', 'submitted', 'processing'].includes(job.status)"
                size="sm"
                variant="danger"
                :loading="actionLoadingId === `${job.id}-cancel`"
                @click="cancelJob(job.id)"
              >
                Cancel
              </BaseButton>

              <!-- Persist Result -->
              <BaseButton
                v-if="job.status === 'completed' && !job.assetVersionId"
                size="sm"
                variant="primary"
                :loading="actionLoadingId === `${job.id}-persist`"
                @click="persistJobResult(job.id)"
              >
                Persist Result to Assets
              </BaseButton>
            </div>
          </BaseCard>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";

type GenerationJob = {
  id: string;
  projectId: string;
  jobType: string;
  status: string;
  providerId: string | null;
  modelId: string | null;
  prompt: string | null;
  targetMediaType: string;
  progress: number | null;
  error: string | null;
  assetVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

type Provider = { id: string; name: string; type: string; enabled: number | boolean };
type Model = { id: string; providerId: string; name: string; modelId: string };

const route = useRoute();
const api = useApi();
const projectId = route.params.id as string;

const loading = ref(true);
const refreshing = ref(false);
const creating = ref(false);
const actionLoadingId = ref<string | null>(null);
const error = ref<string | null>(null);

const jobs = ref<GenerationJob[]>([]);
const providers = ref<Provider[]>([]);
const models = ref<Model[]>([]);

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  switch ((status || "").toLowerCase()) {
    case "active":
    case "completed":
    case "ready":
    case "approved":
      return "success";
    case "in_progress":
    case "processing":
    case "submitted":
    case "downloading":
      return "info";
    case "draft":
    case "pending":
    case "queued":
      return "warning";
    case "archived":
    case "failed":
    case "rejected":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

const form = reactive({
  prompt: "",
  targetMediaType: "image",
  jobType: "text-to-image",
  providerId: "",
  modelId: "",
});

const mediaTypeOptions = [
  { label: "Image", value: "image" },
  { label: "Video", value: "video" },
  { label: "Audio", value: "audio" },
];

const jobTypeOptions = [
  { label: "Text to Image", value: "text-to-image" },
  { label: "Text to Video", value: "text-to-video" },
  { label: "Text to Audio", value: "text-to-audio" },
];

const providerOptions = computed(() => {
  const list = providers.value.map((p) => ({ label: p.name, value: p.id }));
  return [{ label: "Default / Any", value: "" }, ...list];
});

const modelOptions = computed(() => {
  const filtered = form.providerId
    ? models.value.filter((m) => m.providerId === form.providerId)
    : models.value;
  const list = filtered.map((m) => ({ label: m.name, value: m.id }));
  return [{ label: "Default / Any", value: "" }, ...list];
});

function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " " + d.toLocaleDateString();
}

function getProviderName(id: string | null) {
  if (!id) return "Default Provider";
  const p = providers.value.find((prov) => prov.id === id);
  return p ? p.name : id;
}

function getModelName(id: string | null) {
  if (!id) return "Default Model";
  const m = models.value.find((mod) => mod.id === id);
  return m ? m.name : id;
}

async function init() {
  loading.value = true;
  error.value = null;
  try {
    const [jobsData, provData, modData] = await Promise.all([
      api.get<GenerationJob[]>(`/projects/${projectId}/jobs`),
      api.get<Provider[]>("/ai-providers").catch(() => []),
      api.get<Model[]>("/ai-models").catch(() => []),
    ]);
    jobs.value = jobsData || [];
    providers.value = provData || [];
    models.value = modData || [];
  } catch (err: any) {
    error.value = err?.message || "Failed to load generation jobs";
  } finally {
    loading.value = false;
  }
}

async function loadJobs() {
  refreshing.value = true;
  try {
    const jobsData = await api.get<GenerationJob[]>(`/projects/${projectId}/jobs`);
    jobs.value = jobsData || [];
  } catch (err: any) {
    console.error("Failed to refresh jobs", err);
  } finally {
    refreshing.value = false;
  }
}

async function createJob() {
  if (!form.prompt.trim()) return;
  creating.value = true;
  try {
    const created = await api.post<GenerationJob>(`/projects/${projectId}/jobs`, {
      prompt: form.prompt.trim(),
      targetMediaType: form.targetMediaType,
      jobType: form.jobType,
      providerId: form.providerId || null,
      modelId: form.modelId || null,
    });
    jobs.value.unshift(created);
    form.prompt = "";
  } catch (err: any) {
    alert(err?.message || "Failed to create generation job");
  } finally {
    creating.value = false;
  }
}

async function submitJob(id: string) {
  actionLoadingId.value = `${id}-submit`;
  try {
    const updated = await api.post<GenerationJob>(`/jobs/${id}/submit`);
    updateJobInList(updated);
  } catch (err: any) {
    alert(err?.message || "Failed to submit job");
  } finally {
    actionLoadingId.value = null;
  }
}

async function pollJob(id: string) {
  actionLoadingId.value = `${id}-poll`;
  try {
    const updated = await api.post<GenerationJob>(`/jobs/${id}/poll`);
    updateJobInList(updated);
  } catch (err: any) {
    alert(err?.message || "Failed to poll job");
  } finally {
    actionLoadingId.value = null;
  }
}

async function cancelJob(id: string) {
  if (!confirm("Cancel this generation job?")) return;
  actionLoadingId.value = `${id}-cancel`;
  try {
    const updated = await api.post<GenerationJob>(`/jobs/${id}/cancel`);
    updateJobInList(updated);
  } catch (err: any) {
    alert(err?.message || "Failed to cancel job");
  } finally {
    actionLoadingId.value = null;
  }
}

async function persistJobResult(id: string) {
  actionLoadingId.value = `${id}-persist`;
  try {
    const res = await api.post<{ id: string }>(`/projects/${projectId}/jobs/${id}/persist-result`);
    const found = jobs.value.find((j) => j.id === id);
    if (found) {
      found.assetVersionId = res.id;
    }
  } catch (err: any) {
    alert(err?.message || "Failed to persist generation result");
  } finally {
    actionLoadingId.value = null;
  }
}

function updateJobInList(job: GenerationJob) {
  const index = jobs.value.findIndex((j) => j.id === job.id);
  if (index !== -1) {
    jobs.value[index] = job;
  }
}

onMounted(init);
</script>

<style scoped>
.generations-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
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
}

.generations-layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 1.5rem;
  align-items: flex-start;
}

.job-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.jobs-list-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.jobs-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.job-card {
  padding: 1.1rem;
  border: 1px solid #d4dfdd;
}

.job-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.job-meta-left {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.media-type-pill {
  font-size: 0.7rem;
  font-weight: 750;
  text-transform: uppercase;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}

.media-type-pill.image { background: #e3f2fd; color: #1565c0; }
.media-type-pill.video { background: #fce4ec; color: #c2185b; }
.media-type-pill.audio { background: #ede7f6; color: #512da8; }

.progress-badge {
  font-size: 0.75rem;
  font-weight: 700;
  color: #176b65;
  background: #e4f1ef;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}

.time-text {
  font-size: 0.8rem;
  color: #68777c;
}

.prompt-preview {
  margin: 0 0 0.85rem;
  font-size: 0.95rem;
  color: #17212b;
  line-height: 1.4;
}

.job-specs {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  font-size: 0.85rem;
  color: #556968;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid #eef2f1;
}

.persisted-item {
  color: #44711e;
  font-weight: 650;
}

.job-error-box {
  margin: 0.85rem 0 0;
  background: #fdf2f1;
  padding: 0.65rem 0.85rem;
  border-radius: 4px;
  border-left: 3px solid #d32f2f;
}

.error-title {
  font-weight: 700;
  color: #c62828;
  font-size: 0.8rem;
  text-transform: uppercase;
}

.error-detail {
  margin: 0.2rem 0 0;
  font-size: 0.85rem;
  color: #a62e25;
}

.job-actions {
  display: flex;
  gap: 0.65rem;
  margin-top: 1rem;
}

@media (max-width: 900px) {
  .generations-layout {
    grid-template-columns: 1fr;
  }
}
</style>
