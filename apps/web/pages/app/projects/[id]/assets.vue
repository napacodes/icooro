<template>
  <div class="assets-view">
    <div class="view-header">
      <div>
        <h2>Media Assets & Versions</h2>
        <p class="view-subtitle">Manage project media assets across image, video, and audio pipelines.</p>
      </div>

      <!-- Type Filter Tabs -->
      <div class="type-filter">
        <button
          v-for="filter in typeFilters"
          :key="filter.value"
          type="button"
          class="filter-btn"
          :class="{ active: selectedType === filter.value }"
          @click="onTypeFilter(filter.value)"
        >
          {{ filter.label }}
        </button>
      </div>
    </div>

    <LoadingState v-if="loading" message="Loading media assets…" />
    <ErrorBanner
      v-else-if="error"
      :message="error"
      retry-label="Retry"
      @retry="loadAssets"
    />

    <div v-else class="assets-layout">
      <!-- Create Asset Form -->
      <BasePanel
        title="Add Media Asset"
        description="Register a new media asset container in this project."
        class="create-panel"
      >
        <form class="asset-form" @submit.prevent="createAsset">
          <BaseInput
            v-model="form.name"
            label="Asset Name"
            required
            :maxlength="255"
            placeholder="e.g. Hero Keyframe Portrait"
          />
          <BaseSelect
            v-model="form.type"
            label="Media Type"
            :options="mediaTypeOptions"
          />
          <BaseTextarea
            v-model="form.description"
            label="Description / Usage Notes"
            :rows="2"
            placeholder="Primary reference asset for scene lighting…"
          />
          <BaseButton
            type="submit"
            variant="primary"
            :loading="saving"
          >
            Add Asset
          </BaseButton>
        </form>
      </BasePanel>

      <!-- Asset Grid & Versions Inspector -->
      <div class="assets-main">
        <EmptyState
          v-if="filteredAssets.length === 0"
          :title="`No ${selectedType ? selectedType : 'media'} assets found`"
          description="Create a new media asset using the form on the left."
        />
        <div v-else class="assets-grid">
          <BaseCard
            v-for="asset in filteredAssets"
            :key="asset.id"
            class="asset-card"
            :class="{ selected: selectedAsset?.id === asset.id }"
            @click="selectAsset(asset)"
          >
            <div class="card-top">
              <div class="type-and-title">
                <span class="media-type-badge" :class="asset.type">{{ asset.type }}</span>
                <strong class="asset-name">{{ asset.name }}</strong>
              </div>
              <BaseButton
                size="sm"
                variant="danger"
                @click.stop="deleteAsset(asset.id)"
              >
                Delete
              </BaseButton>
            </div>

            <p v-if="asset.description" class="asset-desc">{{ asset.description }}</p>

            <div class="card-status-row">
              <div class="status-group">
                <span class="meta-label">Status:</span>
                <StatusPill :tone="statusTone(asset.status)">{{ asset.status }}</StatusPill>
              </div>
              <div v-if="asset.approvedVersionId" class="approved-tag">
                ✓ Approved
              </div>
            </div>
          </BaseCard>
        </div>

        <!-- Asset Versions Inspector Sub-Panel -->
        <div v-if="selectedAsset" class="versions-panel">
          <BasePanel
            :title="`Versions · ${selectedAsset.name}`"
            description="Manage media asset iterations, approvals, and file storage links."
          >
            <div class="add-version-row">
              <BaseButton
                size="sm"
                variant="secondary"
                @click="showAddVersion = !showAddVersion"
              >
                {{ showAddVersion ? "Cancel" : "Add Version Record" }}
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
                <BaseInput
                  v-model="versionForm.mimeType"
                  label="MIME Type"
                  placeholder="image/png or video/mp4"
                />
              </div>
              <BaseInput
                v-model="versionForm.storageKey"
                label="Storage Key / URI"
                required
                placeholder="projects/123/assets/v1.png"
              />
              <BaseButton
                type="submit"
                variant="primary"
                :loading="savingVersion"
              >
                Save Version
              </BaseButton>
            </form>

            <LoadingState v-if="loadingVersions" message="Loading versions…" />
            <EmptyState
              v-else-if="versions.length === 0"
              title="No versions registered"
              description="Generated media or manual files will link as version records here."
            />
            <div v-else class="versions-cards">
              <div
                v-for="v in versions"
                :key="v.id"
                class="version-row"
                :class="{ approved: v.approvalState === 'approved' }"
              >
                <div class="ver-meta">
                  <strong>Version {{ v.version }}</strong>
                  <span class="storage-key-text">{{ v.storageKey }}</span>
                  <StatusPill :tone="statusTone(v.approvalState)">{{ v.approvalState || 'pending' }}</StatusPill>
                </div>
                <div class="approval-actions">
                  <BaseButton
                    v-if="v.approvalState !== 'approved'"
                    size="sm"
                    variant="secondary"
                    @click="approveVersion(v.id)"
                  >
                    Approve
                  </BaseButton>
                  <BaseButton
                    v-if="v.approvalState !== 'rejected'"
                    size="sm"
                    variant="danger"
                    @click="rejectVersion(v.id)"
                  >
                    Reject
                  </BaseButton>
                </div>
              </div>
            </div>
          </BasePanel>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";

type MediaAsset = {
  id: string;
  projectId: string;
  name: string;
  type: "image" | "video" | "audio";
  status: string;
  description: string | null;
  approvedVersionId: string | null;
};

type AssetVersion = {
  id: string;
  assetId: string;
  version: number;
  storageKey: string;
  fileSize: number | null;
  mimeType: string | null;
  approvalState: string;
};

const route = useRoute();
const api = useApi();
const projectId = route.params.id as string;

const loading = ref(true);
const saving = ref(false);
const savingVersion = ref(false);
const loadingVersions = ref(false);
const showAddVersion = ref(false);
const error = ref<string | null>(null);

const assets = ref<MediaAsset[]>([]);
const versions = ref<AssetVersion[]>([]);
const selectedAsset = ref<MediaAsset | null>(null);
const selectedType = ref<string>("");

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
  name: "",
  type: "image" as "image" | "video" | "audio",
  description: "",
});

const versionForm = reactive({
  version: 1,
  storageKey: "",
  mimeType: "image/png",
});

const mediaTypeOptions = [
  { label: "Image", value: "image" },
  { label: "Video", value: "video" },
  { label: "Audio", value: "audio" },
];

const typeFilters = [
  { label: "All Media", value: "" },
  { label: "Images", value: "image" },
  { label: "Videos", value: "video" },
  { label: "Audio", value: "audio" },
];

const filteredAssets = computed(() => {
  if (!selectedType.value) return assets.value;
  return assets.value.filter((a) => a.type === selectedType.value);
});

async function loadAssets() {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.get<MediaAsset[]>(`/projects/${projectId}/assets`);
    assets.value = data || [];
    if (assets.value.length > 0 && !selectedAsset.value) {
      await selectAsset(assets.value[0]);
    }
  } catch (err: any) {
    error.value = err?.message || "Failed to load media assets";
  } finally {
    loading.value = false;
  }
}

function onTypeFilter(type: string) {
  selectedType.value = type;
}

async function selectAsset(asset: MediaAsset) {
  selectedAsset.value = asset;
  showAddVersion.value = false;
  loadingVersions.value = true;
  try {
    const vData = await api.get<AssetVersion[]>(`/assets/${asset.id}/versions`);
    versions.value = (vData || []).sort((a, b) => a.version - b.version);
    versionForm.version = (versions.value.length ? Math.max(...versions.value.map((v) => v.version)) : 0) + 1;
    versionForm.storageKey = `projects/${projectId}/assets/${asset.id}/v${versionForm.version}.${asset.type === 'video' ? 'mp4' : asset.type === 'audio' ? 'mp3' : 'png'}`;
    versionForm.mimeType = asset.type === "video" ? "video/mp4" : asset.type === "audio" ? "audio/mpeg" : "image/png";
  } catch (err: any) {
    console.error("Failed to load asset versions", err);
    versions.value = [];
  } finally {
    loadingVersions.value = false;
  }
}

async function createAsset() {
  if (!form.name.trim()) return;
  saving.value = true;
  try {
    const created = await api.post<MediaAsset>(`/projects/${projectId}/assets`, {
      name: form.name.trim(),
      type: form.type,
      description: form.description.trim() || null,
    });
    assets.value.push(created);
    form.name = "";
    form.description = "";
    await selectAsset(created);
  } catch (err: any) {
    alert(err?.message || "Failed to create media asset");
  } finally {
    saving.value = false;
  }
}

async function deleteAsset(id: string) {
  if (!confirm("Delete this media asset and all linked versions?")) return;
  try {
    await api.delete(`/assets/${id}`);
    assets.value = assets.value.filter((a) => a.id !== id);
    if (selectedAsset.value?.id === id) {
      selectedAsset.value = assets.value[0] || null;
      if (selectedAsset.value) await selectAsset(selectedAsset.value);
      else versions.value = [];
    }
  } catch (err: any) {
    alert(err?.message || "Failed to delete asset");
  }
}

async function createVersion() {
  if (!selectedAsset.value || !versionForm.storageKey.trim()) return;
  savingVersion.value = true;
  try {
    const created = await api.post<AssetVersion>(`/assets/${selectedAsset.value.id}/versions`, {
      version: versionForm.version,
      storageKey: versionForm.storageKey.trim(),
      mimeType: versionForm.mimeType || null,
    });
    versions.value.push(created);
    versions.value.sort((a, b) => a.version - b.version);
    showAddVersion.value = false;
  } catch (err: any) {
    alert(err?.message || "Failed to add asset version");
  } finally {
    savingVersion.value = false;
  }
}

async function approveVersion(versionId: string) {
  if (!selectedAsset.value) return;
  try {
    const updated = await api.post<MediaAsset>(`/assets/${selectedAsset.value.id}/versions/${versionId}/approve`);
    selectedAsset.value.approvedVersionId = updated.approvedVersionId;
    selectedAsset.value.status = updated.status;
    const found = assets.value.find((a) => a.id === selectedAsset.value?.id);
    if (found) {
      found.approvedVersionId = updated.approvedVersionId;
      found.status = updated.status;
    }
    await selectAsset(selectedAsset.value);
  } catch (err: any) {
    alert(err?.message || "Failed to approve version");
  }
}

async function rejectVersion(versionId: string) {
  if (!selectedAsset.value) return;
  try {
    await api.post<MediaAsset>(`/assets/${selectedAsset.value.id}/versions/${versionId}/reject`);
    await selectAsset(selectedAsset.value);
  } catch (err: any) {
    alert(err?.message || "Failed to reject version");
  }
}

onMounted(loadAssets);
</script>

<style scoped>
.assets-view {
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

.type-filter {
  display: flex;
  gap: 0.5rem;
}

.filter-btn {
  padding: 0.4rem 0.85rem;
  border: 1px solid #b9cdca;
  background: #fff;
  border-radius: 6px;
  font-weight: 600;
  color: #245a56;
  cursor: pointer;
  font-size: 0.85rem;
}

.filter-btn.active {
  background: #176b65;
  color: #fff;
  border-color: #176b65;
}

.assets-layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 1.5rem;
  align-items: flex-start;
}

.asset-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.assets-main {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.assets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.asset-card {
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid #d4dfdd;
}

.asset-card:hover {
  border-color: #176b65;
}

.asset-card.selected {
  border-color: #176b65;
  background: #f0f7f6;
  box-shadow: 0 0 0 1px #176b65;
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.type-and-title {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.media-type-badge {
  font-size: 0.7rem;
  font-weight: 750;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  width: fit-content;
}

.media-type-badge.image { background: #e3f2fd; color: #1565c0; }
.media-type-badge.video { background: #fce4ec; color: #c2185b; }
.media-type-badge.audio { background: #ede7f6; color: #512da8; }

.asset-name {
  font-size: 1.05rem;
  color: #17212b;
}

.asset-desc {
  margin: 0.5rem 0;
  font-size: 0.85rem;
  color: #556968;
}

.card-status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid #eef2f1;
}

.status-group {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.meta-label {
  font-size: 0.75rem;
  color: #68777c;
}

.approved-tag {
  font-size: 0.75rem;
  font-weight: 700;
  color: #44711e;
  background: #e7f3d9;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}

.versions-panel {
  margin-top: 0.5rem;
}

.add-version-row {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 1rem;
}

.version-form {
  background: #f8faf9;
  padding: 1rem;
  border-radius: 6px;
  border: 1px solid #d4dfdd;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  margin-bottom: 1rem;
}

.form-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 0.75rem;
}

.versions-cards {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.version-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: #fff;
  border: 1px solid #e1ebe9;
  border-radius: 6px;
}

.version-row.approved {
  border-left: 3px solid #44711e;
  background: #f9fdf7;
}

.ver-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.storage-key-text {
  font-family: monospace;
  font-size: 0.8rem;
  color: #556968;
}

.approval-actions {
  display: flex;
  gap: 0.5rem;
}

@media (max-width: 900px) {
  .assets-layout {
    grid-template-columns: 1fr;
  }
}
</style>
