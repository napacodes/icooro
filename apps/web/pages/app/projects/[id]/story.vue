<template>
  <div class="story-view">
    <div class="view-header">
      <div>
        <h2>Story & Creative World</h2>
        <p class="view-subtitle">Define the characters, locations, and key props for this production.</p>
      </div>
      <div class="entity-tabs">
        <button
          v-for="tab in entityTabs"
          :key="tab.id"
          type="button"
          class="subtab-btn"
          :class="{ active: currentTab === tab.id }"
          @click="currentTab = tab.id"
        >
          {{ tab.label }} ({{ entityCount(tab.id) }})
        </button>
      </div>
    </div>

    <LoadingState v-if="loading" message="Loading creative world entities…" />
    <ErrorBanner
      v-else-if="error"
      :message="error"
      retry-label="Retry"
      @retry="loadAll"
    />

    <div v-else class="story-layout">
      <!-- Create Entity Form -->
      <BasePanel
        :title="`Add ${activeTabLabel}`"
        :description="`Register a new ${activeTabLabel.toLowerCase()} in this project's story world.`"
        class="create-panel"
      >
        <form class="entity-form" @submit.prevent="createEntity">
          <BaseInput
            v-model="form.name"
            :label="`${activeTabLabel} Name`"
            required
            :maxlength="255"
            :placeholder="`e.g. ${exampleName}`"
          />
          <BaseTextarea
            v-model="form.description"
            label="Narrative Description"
            :rows="2"
            placeholder="Background, personality, lore, or story role…"
          />
          <BaseTextarea
            v-model="form.visualDescription"
            label="Visual Appearance / Prompt Details"
            :rows="2"
            placeholder="Visual characteristics, attire, color palette for generation…"
          />
          <BaseButton
            type="submit"
            variant="primary"
            :loading="saving"
          >
            Add {{ activeTabLabel }}
          </BaseButton>
        </form>
      </BasePanel>

      <!-- Entity List Display -->
      <div class="list-panel">
        <EmptyState
          v-if="currentList.length === 0"
          :title="`No ${activeTabLabel.toLowerCase()}s added yet`"
          :description="`Start developing your story world by adding your first ${activeTabLabel.toLowerCase()} on the left.`"
        />
        <div v-else class="cards-grid">
          <BaseCard
            v-for="item in currentList"
            :key="item.id"
            class="entity-card"
          >
            <div class="card-header">
              <h3 class="entity-name">{{ item.name }}</h3>
              <BaseButton
                size="sm"
                variant="danger"
                @click="deleteItem(item.id)"
              >
                Delete
              </BaseButton>
            </div>
            <p v-if="item.description" class="entity-desc">{{ item.description }}</p>
            <div v-if="item.visualDescription" class="visual-meta">
              <span class="meta-label">Visual prompt notes:</span>
              <p class="visual-text">{{ item.visualDescription }}</p>
            </div>
          </BaseCard>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";

type CreativeEntity = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  visualDescription: string | null;
  referenceAssetId?: string | null;
};

const route = useRoute();
const api = useApi();
const projectId = route.params.id as string;

const currentTab = ref<"characters" | "locations" | "props">("characters");
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

const characters = ref<CreativeEntity[]>([]);
const locations = ref<CreativeEntity[]>([]);
const props = ref<CreativeEntity[]>([]);

const form = reactive({
  name: "",
  description: "",
  visualDescription: "",
});

const entityTabs = [
  { id: "characters" as const, label: "Characters" },
  { id: "locations" as const, label: "Locations" },
  { id: "props" as const, label: "Props" },
];

const activeTabLabel = computed(() => {
  if (currentTab.value === "characters") return "Character";
  if (currentTab.value === "locations") return "Location";
  return "Prop";
});

const exampleName = computed(() => {
  if (currentTab.value === "characters") return "Kaelen Voss";
  if (currentTab.value === "locations") return "Sector 7 Neon Market";
  return "Quantum Datapad";
});

const currentList = computed(() => {
  if (currentTab.value === "characters") return characters.value;
  if (currentTab.value === "locations") return locations.value;
  return props.value;
});

function entityCount(type: "characters" | "locations" | "props") {
  if (type === "characters") return characters.value.length;
  if (type === "locations") return locations.value.length;
  return props.value.length;
}

async function loadAll() {
  loading.value = true;
  error.value = null;
  try {
    const [cData, lData, pData] = await Promise.all([
      api.get<CreativeEntity[]>(`/projects/${projectId}/characters`),
      api.get<CreativeEntity[]>(`/projects/${projectId}/locations`),
      api.get<CreativeEntity[]>(`/projects/${projectId}/props`),
    ]);
    characters.value = cData || [];
    locations.value = lData || [];
    props.value = pData || [];
  } catch (err: any) {
    error.value = err?.message || "Failed to load story assets";
  } finally {
    loading.value = false;
  }
}

async function createEntity() {
  if (!form.name.trim()) return;
  saving.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      visualDescription: form.visualDescription.trim() || null,
    };
    const created = await api.post<CreativeEntity>(
      `/projects/${projectId}/${currentTab.value}`,
      payload,
    );
    if (currentTab.value === "characters") characters.value.push(created);
    else if (currentTab.value === "locations") locations.value.push(created);
    else props.value.push(created);

    form.name = "";
    form.description = "";
    form.visualDescription = "";
  } catch (err: any) {
    alert(err?.message || "Failed to create entity");
  } finally {
    saving.value = false;
  }
}

async function deleteItem(id: string) {
  if (!confirm(`Delete this ${activeTabLabel.value.toLowerCase()}?`)) return;
  try {
    await api.delete(`/${currentTab.value}/${id}`);
    if (currentTab.value === "characters") {
      characters.value = characters.value.filter((i) => i.id !== id);
    } else if (currentTab.value === "locations") {
      locations.value = locations.value.filter((i) => i.id !== id);
    } else {
      props.value = props.value.filter((i) => i.id !== id);
    }
  } catch (err: any) {
    alert(err?.message || "Failed to delete item");
  }
}

onMounted(loadAll);
</script>

<style scoped>
.story-view {
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
}

.entity-tabs {
  display: flex;
  gap: 0.5rem;
}

.subtab-btn {
  padding: 0.45rem 0.9rem;
  border: 1px solid #b9cdca;
  background: #fff;
  border-radius: 6px;
  font-weight: 600;
  color: #245a56;
  cursor: pointer;
  transition: all 0.15s;
}

.subtab-btn.active {
  background: #176b65;
  color: #fff;
  border-color: #176b65;
}

.story-layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 1.5rem;
  align-items: flex-start;
}

.entity-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.entity-name {
  margin: 0;
  font-size: 1.1rem;
  color: #17212b;
}

.entity-desc {
  margin: 0.5rem 0;
  font-size: 0.9rem;
  color: #435458;
}

.visual-meta {
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px dashed #d4dfdd;
}

.meta-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #176b65;
  font-weight: 700;
}

.visual-text {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: #556968;
}

@media (max-width: 900px) {
  .story-layout {
    grid-template-columns: 1fr;
  }
}
</style>
