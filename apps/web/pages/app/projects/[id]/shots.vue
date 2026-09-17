<template>
  <div class="shots-view">
    <div class="view-header">
      <div>
        <h2>Shots & Directing</h2>
        <p class="view-subtitle">Plan and configure camera angles, framing, prompts, and shot versions.</p>
      </div>

      <!-- Episode & Scene Selectors -->
      <div v-if="episodes.length > 0" class="selectors-bar">
        <div class="selector-group">
          <label class="picker-label">Episode:</label>
          <select v-model="selectedEpisodeId" class="picker-select" @change="onEpisodeChange">
            <option v-for="ep in episodes" :key="ep.id" :value="ep.id">
              EP {{ ep.episodeNumber }}: {{ ep.title }}
            </option>
          </select>
        </div>

        <div v-if="scenes.length > 0" class="selector-group">
          <label class="picker-label">Scene:</label>
          <select v-model="selectedSceneId" class="picker-select" @change="onSceneChange">
            <option v-for="sc in scenes" :key="sc.id" :value="sc.id">
              Scene {{ sc.orderIndex }}: {{ sc.name }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <LoadingState v-if="loadingEpisodes" message="Loading production structure…" />
    <ErrorBanner
      v-else-if="error"
      :message="error"
      retry-label="Retry"
      @retry="init"
    />

    <EmptyState
      v-else-if="episodes.length === 0"
      title="No episodes found"
      description="Create an episode first to start planning shots."
    >
      <NuxtLink :to="`/app/projects/${projectId}/episodes`">
        <BaseButton variant="primary">Create Episode</BaseButton>
      </NuxtLink>
    </EmptyState>

    <EmptyState
      v-else-if="scenes.length === 0"
      title="No scenes in this episode"
      description="Add a scene before you can plan shots."
    >
      <NuxtLink :to="`/app/projects/${projectId}/scenes`">
        <BaseButton variant="primary">Create Scene</BaseButton>
      </NuxtLink>
    </EmptyState>

    <div v-else class="shots-layout">
      <!-- Create Shot Column -->
      <div class="shots-sidebar">
        <BasePanel
          title="Add Shot"
          :description="`Add a new camera shot to ${currentScene?.name || 'this scene'}.`"
        >
          <form class="shot-form" @submit.prevent="createShot">
            <div class="form-row">
              <BaseInput
                v-model.number="shotForm.orderIndex"
                type="number"
                label="Shot #"
                required
                min="1"
              />
              <BaseSelect
                v-model="shotForm.shotType"
                label="Shot Type"
                :options="shotTypeOptions"
              />
            </div>
            <div class="form-row">
              <BaseSelect
                v-model="shotForm.framing"
                label="Framing"
                :options="framingOptions"
              />
              <BaseInput
                v-model.number="shotForm.duration"
                type="number"
                label="Duration (sec)"
                min="0"
                placeholder="e.g. 4"
              />
            </div>
            <BaseTextarea
              v-model="shotForm.prompt"
              label="Visual Generation Prompt"
              :rows="3"
              placeholder="Cinematic camera move, dramatic rim lighting, 8k..."
            />
            <BaseTextarea
              v-model="shotForm.actionDescription"
              label="Action / Movement Notes"
              :rows="2"
              placeholder="Character turns slowly toward camera..."
            />
            <BaseButton
              type="submit"
              variant="primary"
              :loading="savingShot"
            >
              Add Shot
            </BaseButton>
          </form>
        </BasePanel>

        <!-- Shots List -->
        <div class="shots-list-box">
          <h3>Shots in Scene {{ currentScene?.orderIndex }} ({{ shots.length }})</h3>
          <EmptyState
            v-if="shots.length === 0"
            title="No shots yet"
            description="Add your first shot above to start framing."
          />
          <div v-else class="shots-items">
            <div
              v-for="shot in shots"
              :key="shot.id"
              class="shot-list-item"
              :class="{ selected: selectedShot?.id === shot.id }"
              @click="selectShot(shot)"
            >
              <div class="shot-meta">
                <span class="shot-num">#{{ shot.orderIndex }}</span>
                <strong>{{ shot.shotType || "Shot" }}</strong>
                <StatusPill :tone="statusTone(shot.status)">{{ shot.status || 'pending' }}</StatusPill>
              </div>
              <BaseButton
                size="sm"
                variant="danger"
                @click.stop="deleteShot(shot.id)"
              >
                Delete
              </BaseButton>
            </div>
          </div>
        </div>
      </div>

      <!-- Shot Inspector & Versions Column -->
      <div class="shot-inspector">
        <template v-if="selectedShot">
          <BasePanel
            :title="`Shot #${selectedShot.orderIndex} — ${selectedShot.shotType || 'Details'}`"
            description="Inspect technical specifications, visual prompts, and shot versions."
          >
            <div class="shot-details-grid">
              <div class="detail-cell">
                <span class="detail-label">Status</span>
                <StatusPill :tone="statusTone(selectedShot.status)">{{ selectedShot.status || 'pending' }}</StatusPill>
              </div>
              <div class="detail-cell">
                <span class="detail-label">Framing</span>
                <span>{{ selectedShot.framing || "Standard" }}</span>
              </div>
              <div class="detail-cell">
                <span class="detail-label">Duration</span>
                <span>{{ selectedShot.duration ? `${selectedShot.duration}s` : "Unset" }}</span>
              </div>
            </div>

            <div v-if="selectedShot.prompt" class="prompt-box">
              <span class="detail-label">Prompt:</span>
              <p class="prompt-text">{{ selectedShot.prompt }}</p>
            </div>

            <div v-if="selectedShot.actionDescription" class="action-box">
              <span class="detail-label">Action Description:</span>
              <p class="action-text">{{ selectedShot.actionDescription }}</p>
            </div>

            <!-- Shot Versions Sub-Panel -->
            <div class="versions-section">
              <div class="versions-header">
                <h4>Shot Versions & Takes ({{ versions.length }})</h4>
                <BaseButton
                  size="sm"
                  variant="secondary"
                  @click="showAddVersion = !showAddVersion"
                >
                  {{ showAddVersion ? "Cancel" : "Add Version" }}
                </BaseButton>
              </div>

              <form v-if="showAddVersion" class="version-form" @submit.prevent="createVersion">
                <div class="form-row">
                  <BaseInput
                    v-model.number="versionForm.version"
                    type="number"
                    label="Version #"
                    required
                    min="1"
                  />
                  <BaseSelect
                    v-model="versionForm.status"
                    label="Status"
                    :options="versionStatusOptions"
                  />
                </div>
                <BaseTextarea
                  v-model="versionForm.prompt"
                  label="Version Prompt Override"
                  :rows="2"
                  placeholder="Leave blank to inherit shot prompt…"
                />
                <label class="checkbox-row">
                  <input
                    v-model="versionForm.productionReady"
                    type="checkbox"
                    :true-value="1"
                    :false-value="0"
                  />
                  <span>Mark as Production Ready</span>
                </label>
                <BaseButton
                  type="submit"
                  variant="primary"
                  :loading="savingVersion"
                >
                  Save Version
                </BaseButton>
              </form>

              <EmptyState
                v-if="versions.length === 0"
                title="No versions recorded yet"
                description="Create a version take to iterate on generative prompts or renders."
              />
              <div v-else class="versions-list">
                <BaseCard
                  v-for="ver in versions"
                  :key="ver.id"
                  class="version-card"
                >
                  <div class="ver-top">
                    <div class="ver-title">
                      <strong>Take v{{ ver.version }}</strong>
                      <span v-if="ver.productionReady === 1" class="ready-badge">Production Ready</span>
                      <StatusPill :tone="statusTone(ver.status)">{{ ver.status }}</StatusPill>
                    </div>
                    <BaseButton
                      size="sm"
                      variant="danger"
                      @click="deleteVersion(ver.id)"
                    >
                      Delete
                    </BaseButton>
                  </div>
                  <p v-if="ver.prompt" class="ver-prompt">{{ ver.prompt }}</p>
                </BaseCard>
              </div>
            </div>
          </BasePanel>
        </template>

        <EmptyState
          v-else
          title="Select a shot"
          description="Click on any shot from the left list to inspect its details and versions."
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";

type Episode = { id: string; title: string; episodeNumber: number };
type Scene = { id: string; episodeId: string; name: string; orderIndex: number };
type Shot = {
  id: string;
  sceneId: string;
  orderIndex: number;
  shotType: string | null;
  framing: string | null;
  duration: number | null;
  prompt: string | null;
  actionDescription: string | null;
  status: string;
};
type ShotVersion = {
  id: string;
  shotId: string;
  version: number;
  prompt: string | null;
  status: string;
  duration: number | null;
  productionReady: number;
};

const route = useRoute();
const api = useApi();
const projectId = route.params.id as string;

const loadingEpisodes = ref(true);
const savingShot = ref(false);
const savingVersion = ref(false);
const showAddVersion = ref(false);
const error = ref<string | null>(null);

const episodes = ref<Episode[]>([]);
const scenes = ref<Scene[]>([]);
const shots = ref<Shot[]>([]);
const versions = ref<ShotVersion[]>([]);

const selectedEpisodeId = ref<string>("");
const selectedSceneId = ref<string>("");
const selectedShot = ref<Shot | null>(null);

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

const shotForm = reactive({
  orderIndex: 1,
  shotType: "Medium Shot",
  framing: "Eye Level",
  duration: 4,
  prompt: "",
  actionDescription: "",
});

const versionForm = reactive({
  version: 1,
  prompt: "",
  status: "pending",
  productionReady: 0,
});

const shotTypeOptions = [
  { label: "Close Up", value: "Close Up" },
  { label: "Medium Shot", value: "Medium Shot" },
  { label: "Wide Shot", value: "Wide Shot" },
  { label: "Extreme Wide Shot", value: "Extreme Wide Shot" },
  { label: "Over the Shoulder", value: "Over the Shoulder" },
  { label: "Point of View", value: "Point of View" },
];

const framingOptions = [
  { label: "Eye Level", value: "Eye Level" },
  { label: "Low Angle", value: "Low Angle" },
  { label: "High Angle", value: "High Angle" },
  { label: "Dutch Angle", value: "Dutch Angle" },
  { label: "Bird's Eye", value: "Bird's Eye" },
];

const versionStatusOptions = [
  { label: "Pending", value: "pending" },
  { label: "Generating", value: "generating" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
];

const currentScene = computed(() =>
  scenes.value.find((s) => s.id === selectedSceneId.value),
);

async function init() {
  loadingEpisodes.value = true;
  error.value = null;
  try {
    const epData = await api.get<Episode[]>(`/projects/${projectId}/episodes`);
    episodes.value = epData || [];
    if (episodes.value.length > 0) {
      selectedEpisodeId.value = episodes.value[0].id;
      await loadScenes(selectedEpisodeId.value);
    }
  } catch (err: any) {
    error.value = err?.message || "Failed to load episodes";
  } finally {
    loadingEpisodes.value = false;
  }
}

async function loadScenes(epId: string) {
  try {
    const scData = await api.get<Scene[]>(`/episodes/${epId}/scenes`);
    scenes.value = (scData || []).sort((a, b) => a.orderIndex - b.orderIndex);

    // If query has sceneId, select it, else first scene
    const querySceneId = route.query.sceneId as string | undefined;
    const target = scenes.value.find((s) => s.id === querySceneId) || scenes.value[0];
    if (target) {
      selectedSceneId.value = target.id;
      await loadShots(target.id);
    } else {
      shots.value = [];
      selectedShot.value = null;
    }
  } catch (err: any) {
    console.error("Failed to load scenes", err);
    scenes.value = [];
  }
}

async function loadShots(sceneId: string) {
  try {
    const sData = await api.get<Shot[]>(`/scenes/${sceneId}/shots`);
    shots.value = (sData || []).sort((a, b) => a.orderIndex - b.orderIndex);
    shotForm.orderIndex = (shots.value.length ? Math.max(...shots.value.map((s) => s.orderIndex)) : 0) + 1;
    if (shots.value.length > 0) {
      await selectShot(shots.value[0]);
    } else {
      selectedShot.value = null;
      versions.value = [];
    }
  } catch (err: any) {
    console.error("Failed to load shots", err);
    shots.value = [];
  }
}

async function selectShot(shot: Shot) {
  selectedShot.value = shot;
  showAddVersion.value = false;
  try {
    const vData = await api.get<ShotVersion[]>(`/shots/${shot.id}/versions`);
    versions.value = (vData || []).sort((a, b) => a.version - b.version);
    versionForm.version = (versions.value.length ? Math.max(...versions.value.map((v) => v.version)) : 0) + 1;
  } catch (err: any) {
    console.error("Failed to load shot versions", err);
    versions.value = [];
  }
}

async function onEpisodeChange() {
  if (selectedEpisodeId.value) {
    await loadScenes(selectedEpisodeId.value);
  }
}

async function onSceneChange() {
  if (selectedSceneId.value) {
    await loadShots(selectedSceneId.value);
  }
}

async function createShot() {
  if (!selectedSceneId.value) return;
  savingShot.value = true;
  try {
    const created = await api.post<Shot>(`/scenes/${selectedSceneId.value}/shots`, {
      orderIndex: shotForm.orderIndex,
      shotType: shotForm.shotType,
      framing: shotForm.framing,
      duration: shotForm.duration || null,
      prompt: shotForm.prompt.trim() || null,
      actionDescription: shotForm.actionDescription.trim() || null,
      status: "pending",
    });
    shots.value.push(created);
    shots.value.sort((a, b) => a.orderIndex - b.orderIndex);
    shotForm.prompt = "";
    shotForm.actionDescription = "";
    shotForm.orderIndex = shots.value.length + 1;
    await selectShot(created);
  } catch (err: any) {
    alert(err?.message || "Failed to create shot");
  } finally {
    savingShot.value = false;
  }
}

async function deleteShot(id: string) {
  if (!confirm("Delete this shot and its versions?")) return;
  try {
    await api.delete(`/shots/${id}`);
    shots.value = shots.value.filter((s) => s.id !== id);
    if (selectedShot.value?.id === id) {
      selectedShot.value = shots.value[0] || null;
      if (selectedShot.value) await selectShot(selectedShot.value);
      else versions.value = [];
    }
  } catch (err: any) {
    alert(err?.message || "Failed to delete shot");
  }
}

async function createVersion() {
  if (!selectedShot.value) return;
  savingVersion.value = true;
  try {
    const created = await api.post<ShotVersion>(`/shots/${selectedShot.value.id}/versions`, {
      version: versionForm.version,
      prompt: versionForm.prompt.trim() || null,
      status: versionForm.status,
      productionReady: versionForm.productionReady,
    });
    versions.value.push(created);
    versions.value.sort((a, b) => a.version - b.version);
    versionForm.prompt = "";
    versionForm.version = created.version + 1;
    showAddVersion.value = false;
  } catch (err: any) {
    alert(err?.message || "Failed to add shot version");
  } finally {
    savingVersion.value = false;
  }
}

async function deleteVersion(id: string) {
  if (!confirm("Delete this version take?")) return;
  try {
    await api.delete(`/shot-versions/${id}`);
    versions.value = versions.value.filter((v) => v.id !== id);
  } catch (err: any) {
    alert(err?.message || "Failed to delete shot version");
  }
}

onMounted(init);
</script>

<style scoped>
.shots-view {
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

.selectors-bar {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.selector-group {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.picker-label {
  font-weight: 600;
  font-size: 0.85rem;
  color: #556968;
}

.picker-select {
  padding: 0.4rem 0.75rem;
  border: 1px solid #b9cdca;
  border-radius: 6px;
  background: #fff;
  font-weight: 600;
  color: #17212b;
  font-size: 0.9rem;
}

.shots-layout {
  display: grid;
  grid-template-columns: 400px 1fr;
  gap: 1.5rem;
  align-items: flex-start;
}

.shots-sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.shot-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.shots-list-box h3 {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
  color: #17212b;
}

.shots-items {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.shot-list-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.shot-list-item:hover {
  border-color: #176b65;
}

.shot-list-item.selected {
  border-color: #176b65;
  background: #f0f7f6;
  box-shadow: 0 0 0 1px #176b65;
}

.shot-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.shot-num {
  font-size: 0.75rem;
  font-weight: 750;
  color: #176b65;
  background: #e4f1ef;
  padding: 0.2rem 0.45rem;
  border-radius: 4px;
}

.shot-inspector {
  min-height: 400px;
}

.shot-details-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #eef2f1;
}

.detail-cell {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.detail-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  font-weight: 700;
  color: #68777c;
  letter-spacing: 0.05em;
}

.prompt-box, .action-box {
  margin-top: 1rem;
  background: #f8faf9;
  padding: 0.85rem;
  border-radius: 6px;
  border: 1px solid #e1ebe9;
}

.prompt-text, .action-text {
  margin: 0.35rem 0 0;
  font-size: 0.9rem;
  color: #17212b;
}

.versions-section {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 2px solid #e1ebe9;
}

.versions-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.versions-header h4 {
  margin: 0;
  font-size: 1.05rem;
  color: #17212b;
}

.version-form {
  background: #f0f7f6;
  padding: 1rem;
  border-radius: 6px;
  border: 1px solid #c2ded9;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  margin-bottom: 1rem;
}

.checkbox-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: #245a56;
}

.versions-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.version-card {
  padding: 0.85rem;
}

.ver-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.ver-title {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.ready-badge {
  font-size: 0.75rem;
  font-weight: 700;
  background: #e7f3d9;
  color: #44711e;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}

.ver-prompt {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: #556968;
}

@media (max-width: 960px) {
  .shots-layout {
    grid-template-columns: 1fr;
  }
}
</style>
