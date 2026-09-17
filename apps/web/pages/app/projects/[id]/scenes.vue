<template>
  <div class="scenes-view">
    <div class="view-header">
      <div>
        <h2>Scenes</h2>
        <p class="view-subtitle">Break down episodes into visual scenes and narrative moments.</p>
      </div>
      <div v-if="episodes.length > 0" class="episode-picker">
        <label for="ep-select" class="picker-label">Active Episode:</label>
        <select
          id="ep-select"
          v-model="selectedEpisodeId"
          class="picker-select"
          @change="onEpisodeChange"
        >
          <option
            v-for="ep in episodes"
            :key="ep.id"
            :value="ep.id"
          >
            EP {{ ep.episodeNumber }}: {{ ep.title }}
          </option>
        </select>
      </div>
    </div>

    <LoadingState v-if="loadingEpisodes" message="Loading project episodes…" />
    <ErrorBanner
      v-else-if="error"
      :message="error"
      retry-label="Retry"
      @retry="init"
    />

    <EmptyState
      v-else-if="episodes.length === 0"
      title="No episodes found"
      description="You must create an episode before you can add and organize scenes."
    >
      <NuxtLink :to="`/app/projects/${projectId}/episodes`">
        <BaseButton variant="primary">Go to Episodes</BaseButton>
      </NuxtLink>
    </EmptyState>

    <div v-else class="scenes-layout">
      <!-- Create Scene Form -->
      <BasePanel
        title="Add Scene"
        :description="`Add a scene to ${currentEpisode?.title || 'the selected episode'}.`"
        class="create-panel"
      >
        <form class="scene-form" @submit.prevent="createScene">
          <BaseInput
            v-model="form.name"
            label="Scene Name / Slugline"
            required
            :maxlength="255"
            placeholder="e.g. Neon Alley Confrontation"
          />
          <BaseInput
            v-model.number="form.orderIndex"
            type="number"
            label="Scene Order #"
            required
            min="1"
          />
          <BaseTextarea
            v-model="form.description"
            label="Production / Location Notes"
            :rows="3"
            placeholder="Atmosphere, time of day, dramatic tension, key events…"
          />
          <BaseButton
            type="submit"
            variant="primary"
            :loading="saving"
          >
            Add Scene
          </BaseButton>
        </form>
      </BasePanel>

      <!-- Scenes List -->
      <div class="scenes-list-panel">
        <div class="list-heading">
          <h3>Scenes in EP {{ currentEpisode?.episodeNumber }} ({{ scenes.length }})</h3>
        </div>

        <LoadingState v-if="loadingScenes" message="Loading scenes…" />
        <EmptyState
          v-else-if="scenes.length === 0"
          title="No scenes in this episode yet"
          description="Use the form on the left to add the first scene."
        />
        <div v-else class="scenes-grid">
          <BaseCard
            v-for="scene in scenes"
            :key="scene.id"
            class="scene-card"
          >
            <div class="scene-header">
              <div class="scene-title-row">
                <span class="scene-badge">SCENE {{ scene.orderIndex }}</span>
                <h4 class="scene-name">{{ scene.name }}</h4>
              </div>
              <BaseButton
                size="sm"
                variant="danger"
                @click="deleteScene(scene.id)"
              >
                Delete
              </BaseButton>
            </div>
            <p v-if="scene.description" class="scene-desc">{{ scene.description }}</p>
            <div class="scene-footer">
              <NuxtLink :to="`/app/projects/${projectId}/shots?sceneId=${scene.id}`" class="shots-link">
                View & Plan Shots →
              </NuxtLink>
            </div>
          </BaseCard>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";

type Episode = {
  id: string;
  projectId: string;
  title: string;
  episodeNumber: number;
};

type Scene = {
  id: string;
  episodeId: string;
  name: string;
  description: string | null;
  orderIndex: number;
};

const route = useRoute();
const api = useApi();
const projectId = route.params.id as string;

const loadingEpisodes = ref(true);
const loadingScenes = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const episodes = ref<Episode[]>([]);
const scenes = ref<Scene[]>([]);
const selectedEpisodeId = ref<string>("");

const form = reactive({
  name: "",
  orderIndex: 1,
  description: "",
});

const currentEpisode = computed(() =>
  episodes.value.find((e) => e.id === selectedEpisodeId.value),
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
  loadingScenes.value = true;
  try {
    const data = await api.get<Scene[]>(`/episodes/${epId}/scenes`);
    scenes.value = (data || []).sort((a, b) => a.orderIndex - b.orderIndex);
    form.orderIndex = (scenes.value.length ? Math.max(...scenes.value.map((s) => s.orderIndex)) : 0) + 1;
  } catch (err: any) {
    console.error("Failed to load scenes", err);
    scenes.value = [];
  } finally {
    loadingScenes.value = false;
  }
}

async function onEpisodeChange() {
  if (selectedEpisodeId.value) {
    await loadScenes(selectedEpisodeId.value);
  }
}

async function createScene() {
  if (!selectedEpisodeId.value || !form.name.trim()) return;
  saving.value = true;
  try {
    const created = await api.post<Scene>(`/episodes/${selectedEpisodeId.value}/scenes`, {
      name: form.name.trim(),
      orderIndex: form.orderIndex,
      description: form.description.trim() || null,
    });
    scenes.value.push(created);
    scenes.value.sort((a, b) => a.orderIndex - b.orderIndex);
    form.name = "";
    form.description = "";
    form.orderIndex = scenes.value.length + 1;
  } catch (err: any) {
    alert(err?.message || "Failed to create scene");
  } finally {
    saving.value = false;
  }
}

async function deleteScene(id: string) {
  if (!confirm("Delete this scene and its shots?")) return;
  try {
    await api.delete(`/scenes/${id}`);
    scenes.value = scenes.value.filter((s) => s.id !== id);
  } catch (err: any) {
    alert(err?.message || "Failed to delete scene");
  }
}

onMounted(init);
</script>

<style scoped>
.scenes-view {
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

.episode-picker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.picker-label {
  font-weight: 600;
  font-size: 0.9rem;
  color: #556968;
}

.picker-select {
  padding: 0.45rem 0.85rem;
  border: 1px solid #b9cdca;
  border-radius: 6px;
  background: #fff;
  font-weight: 600;
  color: #17212b;
}

.scenes-layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 1.5rem;
  align-items: flex-start;
}

.scene-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.list-heading h3 {
  margin: 0 0 1rem;
  font-size: 1.1rem;
  color: #17212b;
}

.scenes-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.scene-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.scene-title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.scene-badge {
  font-size: 0.75rem;
  font-weight: 750;
  background: #e4f1ef;
  color: #176b65;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
}

.scene-name {
  margin: 0;
  font-size: 1.05rem;
  color: #17212b;
}

.scene-desc {
  margin: 0.65rem 0 0;
  font-size: 0.9rem;
  color: #556968;
}

.scene-footer {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid #eef2f1;
}

.shots-link {
  color: #176b65;
  font-size: 0.85rem;
  font-weight: 650;
  text-decoration: none;
}

.shots-link:hover {
  text-decoration: underline;
}

@media (max-width: 900px) {
  .scenes-layout {
    grid-template-columns: 1fr;
  }
}
</style>
