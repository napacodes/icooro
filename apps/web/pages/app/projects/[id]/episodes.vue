<template>
  <div class="episodes-view">
    <div class="view-header">
      <div>
        <h2>Episodes & Scripts</h2>
        <p class="view-subtitle">Organize production into episodic units and track script revisions.</p>
      </div>
    </div>

    <LoadingState v-if="loading" message="Loading episodes…" />
    <ErrorBanner
      v-else-if="error"
      :message="error"
      retry-label="Retry"
      @retry="loadEpisodes"
    />

    <div v-else class="episodes-layout">
      <!-- Create Episode & List Column -->
      <div class="episodes-col">
        <BasePanel
          title="Add Episode"
          description="Create a new episodic production unit."
          class="create-panel"
        >
          <form class="episode-form" @submit.prevent="createEpisode">
            <BaseInput
              v-model="episodeForm.title"
              label="Episode Title"
              required
              :maxlength="255"
              placeholder="e.g. Chapter 1: The Arrival"
            />
            <div class="form-row">
              <BaseInput
                v-model.number="episodeForm.episodeNumber"
                type="number"
                label="Episode #"
                required
                min="1"
              />
              <BaseSelect
                v-model="episodeForm.status"
                label="Status"
                :options="episodeStatusOptions"
              />
            </div>
            <BaseButton
              type="submit"
              variant="primary"
              :loading="savingEpisode"
            >
              Add Episode
            </BaseButton>
          </form>
        </BasePanel>

        <div class="episodes-list-panel">
          <h3>Episodes ({{ episodes.length }})</h3>
          <EmptyState
            v-if="episodes.length === 0"
            title="No episodes yet"
            description="Create your first episode above to structure your narrative."
          />
          <div v-else class="episodes-cards">
            <div
              v-for="ep in episodes"
              :key="ep.id"
              class="episode-item"
              :class="{ selected: selectedEpisode?.id === ep.id }"
              @click="selectEpisode(ep)"
            >
              <div class="episode-info">
                <span class="ep-num">EP {{ ep.episodeNumber }}</span>
                <strong class="ep-title">{{ ep.title }}</strong>
                <StatusPill :tone="statusTone(ep.status)">{{ ep.status }}</StatusPill>
              </div>
              <div class="episode-actions" @click.stop>
                <BaseButton
                  size="sm"
                  variant="danger"
                  @click="deleteEpisode(ep.id)"
                >
                  Delete
                </BaseButton>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Selected Episode Script Inspector Column -->
      <div class="script-col">
        <BasePanel
          v-if="selectedEpisode"
          :title="`${selectedEpisode.title} — Scripts`"
          description="Manage script versions and scene dialogues."
        >
          <form class="script-form" @submit.prevent="createScript">
            <BaseTextarea
              v-model="scriptForm.content"
              label="Script Content / Screenplay Draft"
              :rows="6"
              required
              placeholder="SCENE START: INT. NEON STREETS - NIGHT&#10;Kaelen steps out into the rain..."
            />
            <div class="script-form-row">
              <BaseInput
                v-model.number="scriptForm.version"
                type="number"
                label="Revision Version"
                required
                min="1"
              />
              <BaseButton
                type="submit"
                variant="primary"
                :loading="savingScript"
              >
                Add Script Version
              </BaseButton>
            </div>
          </form>

          <div class="scripts-list">
            <h4>Script Versions ({{ scripts.length }})</h4>
            <EmptyState
              v-if="scripts.length === 0"
              title="No script revisions yet"
              description="Add version 1 of the screenplay using the form above."
            />
            <div v-else class="script-versions">
              <BaseCard
                v-for="script in scripts"
                :key="script.id"
                class="script-card"
              >
                <div class="script-header">
                  <span class="version-tag">Version {{ script.version }}</span>
                  <BaseButton
                    size="sm"
                    variant="danger"
                    @click="deleteScript(script.id)"
                  >
                    Delete
                  </BaseButton>
                </div>
                <pre class="script-preview">{{ script.content }}</pre>
              </BaseCard>
            </div>
          </div>
        </BasePanel>

        <EmptyState
          v-else
          title="Select an episode"
          description="Choose an episode from the list to view and manage its scripts."
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";

type Episode = {
  id: string;
  projectId: string;
  title: string;
  episodeNumber: number;
  status: string;
};

type Script = {
  id: string;
  episodeId: string;
  content: string;
  version: number;
};

const route = useRoute();
const api = useApi();
const projectId = route.params.id as string;

const loading = ref(true);
const savingEpisode = ref(false);
const savingScript = ref(false);
const error = ref<string | null>(null);

const episodes = ref<Episode[]>([]);
const scripts = ref<Script[]>([]);
const selectedEpisode = ref<Episode | null>(null);

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

const episodeForm = reactive({
  title: "",
  episodeNumber: 1,
  status: "draft",
});

const scriptForm = reactive({
  content: "",
  version: 1,
});

const episodeStatusOptions = [
  { label: "Draft", value: "draft" },
  { label: "Writing", value: "writing" },
  { label: "In Production", value: "in_production" },
  { label: "Completed", value: "completed" },
];

async function loadEpisodes() {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.get<Episode[]>(`/projects/${projectId}/episodes`);
    episodes.value = data || [];
    if (episodes.value.length > 0 && !selectedEpisode.value) {
      await selectEpisode(episodes.value[0]);
    }
  } catch (err: any) {
    error.value = err?.message || "Failed to load episodes";
  } finally {
    loading.value = false;
  }
}

async function selectEpisode(ep: Episode) {
  selectedEpisode.value = ep;
  try {
    const data = await api.get<Script[]>(`/episodes/${ep.id}/script`);
    scripts.value = data || [];
    scriptForm.version = (scripts.value.length ? Math.max(...scripts.value.map((s) => s.version)) : 0) + 1;
  } catch (err: any) {
    console.error("Failed to load scripts", err);
    scripts.value = [];
  }
}

async function createEpisode() {
  if (!episodeForm.title.trim()) return;
  savingEpisode.value = true;
  try {
    const created = await api.post<Episode>(`/projects/${projectId}/episodes`, {
      title: episodeForm.title.trim(),
      episodeNumber: episodeForm.episodeNumber,
      status: episodeForm.status,
    });
    episodes.value.push(created);
    episodeForm.title = "";
    episodeForm.episodeNumber = episodes.value.length + 1;
    await selectEpisode(created);
  } catch (err: any) {
    alert(err?.message || "Failed to create episode");
  } finally {
    savingEpisode.value = false;
  }
}

async function deleteEpisode(id: string) {
  if (!confirm("Delete this episode and its related scripts and scenes?")) return;
  try {
    await api.delete(`/episodes/${id}`);
    episodes.value = episodes.value.filter((e) => e.id !== id);
    if (selectedEpisode.value?.id === id) {
      selectedEpisode.value = episodes.value[0] || null;
      if (selectedEpisode.value) {
        await selectEpisode(selectedEpisode.value);
      } else {
        scripts.value = [];
      }
    }
  } catch (err: any) {
    alert(err?.message || "Failed to delete episode");
  }
}

async function createScript() {
  if (!selectedEpisode.value || !scriptForm.content.trim()) return;
  savingScript.value = true;
  try {
    const created = await api.post<Script>(`/episodes/${selectedEpisode.value.id}/script`, {
      content: scriptForm.content.trim(),
      version: scriptForm.version,
    });
    scripts.value.push(created);
    scriptForm.content = "";
    scriptForm.version = created.version + 1;
  } catch (err: any) {
    alert(err?.message || "Failed to create script version");
  } finally {
    savingScript.value = false;
  }
}

async function deleteScript(id: string) {
  if (!confirm("Delete this script version?")) return;
  try {
    await api.delete(`/scripts/${id}`);
    scripts.value = scripts.value.filter((s) => s.id !== id);
  } catch (err: any) {
    alert(err?.message || "Failed to delete script");
  }
}

onMounted(loadEpisodes);
</script>

<style scoped>
.episodes-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
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

.episodes-layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 1.5rem;
  align-items: flex-start;
}

.episodes-col {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.episode-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 0.75rem;
}

.episodes-list-panel h3 {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
  color: #17212b;
}

.episodes-cards {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.episode-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.85rem 1rem;
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.episode-item:hover {
  border-color: #176b65;
}

.episode-item.selected {
  border-color: #176b65;
  background: #f0f7f6;
  box-shadow: 0 0 0 1px #176b65;
}

.episode-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.ep-num {
  font-size: 0.75rem;
  font-weight: 700;
  color: #176b65;
  background: #e4f1ef;
  padding: 0.2rem 0.45rem;
  border-radius: 4px;
}

.ep-title {
  color: #17212b;
  font-size: 0.95rem;
}

.script-col {
  min-height: 400px;
}

.script-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.script-form-row {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
}

.scripts-list h4 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  color: #17212b;
}

.script-versions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.script-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.version-tag {
  font-weight: 700;
  color: #176b65;
  font-size: 0.85rem;
}

.script-preview {
  margin: 0;
  white-space: pre-wrap;
  font-family: monospace;
  font-size: 0.85rem;
  background: #f8faf9;
  padding: 0.75rem;
  border-radius: 4px;
  border: 1px solid #e1ebe9;
  color: #334;
  max-height: 250px;
  overflow-y: auto;
}

@media (max-width: 900px) {
  .episodes-layout {
    grid-template-columns: 1fr;
  }
}
</style>
