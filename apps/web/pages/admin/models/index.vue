<script setup lang="ts">
import {
  APP_NAME,
  GENERATION_JOB_TYPES,
  type AiModel,
  type AiProvider,
} from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminModelsPage" });

const api = useApi();

const models = ref<AiModel[]>([]);
const providers = ref<AiProvider[]>([]);
const loading = ref(true);
const error = ref("");
const updatingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);

// --- Model create/edit form -----------------------------------------------
const showForm = ref(false);
const formMode = ref<"create" | "edit">("create");
const formSaving = ref(false);
const formError = ref("");
const form = reactive({
  id: "",
  providerId: "",
  name: "",
  modelId: "",
  capability: "video",
  jobTypes: [] as string[],
  enabled: true,
});

const formTitle = computed(() =>
  formMode.value === "create" ? "Add AI Model" : "Edit AI Model",
);

function resetForm() {
  form.id = "";
  form.providerId = "";
  form.name = "";
  form.modelId = "";
  form.capability = "video";
  form.jobTypes = [];
  form.enabled = true;
  formError.value = "";
}

function openCreateForm() {
  resetForm();
  formMode.value = "create";
  if (providers.value.length > 0) {
    form.providerId = providers.value[0]!.id;
  }
  showForm.value = true;
}

function openEditForm(model: AiModel) {
  resetForm();
  formMode.value = "edit";
  form.id = model.id;
  form.providerId = model.providerId;
  form.name = model.name;
  form.modelId = model.modelId;
  form.capability = model.capability;
  form.jobTypes = [...(model.jobTypes ?? [])];
  form.enabled = model.enabled;
  showForm.value = true;
}

const providerOptions = computed(() =>
  providers.value.map((p) => ({ label: p.name, value: p.id })),
);

const capabilityOptions = [
  { label: "Video", value: "video" },
  { label: "Image", value: "image" },
  { label: "Audio", value: "audio" },
  { label: "Text", value: "text" },
];

const jobTypeOptions = GENERATION_JOB_TYPES.map((t) => ({
  label: t,
  value: t,
}));

function toggleJobType(value: string) {
  const idx = form.jobTypes.indexOf(value);
  if (idx === -1) {
    form.jobTypes = [...form.jobTypes, value];
  } else {
    form.jobTypes = form.jobTypes.filter((t) => t !== value);
  }
}

// --- Data loading ---------------------------------------------------------

async function loadModels() {
  loading.value = true;
  error.value = "";
  try {
    models.value = await api.get<AiModel[]>("/admin/models");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Failed to load models.";
  } finally {
    loading.value = false;
  }
}

async function loadProviders() {
  try {
    providers.value = await api.get<AiProvider[]>("/admin/providers");
  } catch {
    providers.value = [];
  }
}

function providerNameOf(model: AiModel): string {
  return model.providerName ?? providers.value.find((p) => p.id === model.providerId)?.name ?? model.providerId;
}

async function toggleModel(model: AiModel) {
  updatingId.value = model.id;
  try {
    const updated = await api.patch<AiModel>(`/admin/models/${model.id}`, {
      enabled: !model.enabled,
    });
    const idx = models.value.findIndex((m) => m.id === model.id);
    if (idx !== -1) {
      models.value[idx] = updated;
    }
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : "Failed to update model.");
  } finally {
    updatingId.value = null;
  }
}

async function saveModel() {
  if (!form.providerId || !form.name.trim() || !form.modelId.trim()) {
    formError.value = "Provider, name, and external model ID are required.";
    return;
  }
  formSaving.value = true;
  formError.value = "";
  try {
    if (formMode.value === "create") {
      const created = await api.post<AiModel>("/admin/models", {
        providerId: form.providerId,
        name: form.name.trim(),
        modelId: form.modelId.trim(),
        capability: form.capability,
        jobTypes: form.jobTypes.length > 0 ? form.jobTypes : null,
        enabled: form.enabled,
      });
      models.value = [...models.value, created];
    } else {
      const updated = await api.patch<AiModel>(`/admin/models/${form.id}`, {
        name: form.name.trim(),
        modelId: form.modelId.trim(),
        capability: form.capability,
        jobTypes: form.jobTypes.length > 0 ? form.jobTypes : null,
        enabled: form.enabled,
      });
      const idx = models.value.findIndex((m) => m.id === form.id);
      if (idx !== -1) {
        models.value[idx] = updated;
      }
    }
    showForm.value = false;
    resetForm();
  } catch (err: unknown) {
    formError.value = err instanceof Error ? err.message : "Failed to save model.";
  } finally {
    formSaving.value = false;
  }
}

async function deleteModel(model: AiModel) {
  if (
    !confirm(
      `Delete model "${model.name}"? This is only allowed when no generation jobs reference it.`,
    )
  ) {
    return;
  }
  deletingId.value = model.id;
  try {
    await api.delete(`/admin/models/${model.id}`);
    models.value = models.value.filter((m) => m.id !== model.id);
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : "Failed to delete model.");
  } finally {
    deletingId.value = null;
  }
}

onMounted(() => {
  loadModels();
  loadProviders();
});
</script>

<template>
  <section class="admin-page">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <div class="title-row">
      <div>
        <h1>AI Models</h1>
        <p class="lede">
          Generation models bound to a provider. The external model ID is what the provider API
          receives; job types drive filtering in the project generation UI.
        </p>
      </div>
      <div class="actions-row">
        <button class="btn-secondary" :disabled="loading" @click="loadModels">Refresh</button>
        <button class="btn-primary" :disabled="providers.length === 0" @click="openCreateForm">
          + Add Model
        </button>
      </div>
    </div>

    <div v-if="loading" class="status-msg" role="status">Loading AI models…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>
    <div v-else-if="models.length === 0" class="empty-state">
      <p>No AI models configured in the system.</p>
      <p class="empty-hint">Add a provider first, then bind a model to it.</p>
    </div>

    <div v-else class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Capability</th>
            <th>Job Types</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in models" :key="m.id">
            <td class="primary-cell">
              <strong>{{ m.name }}</strong>
              <code>{{ m.modelId }}</code>
              <span class="subtext">{{ m.id }}</span>
            </td>
            <td>
              <span class="cap-badge">{{ m.capability }}</span>
            </td>
            <td>
              <span v-if="m.jobTypes && m.jobTypes.length" class="job-types">
                {{ m.jobTypes.join(', ') }}
              </span>
              <span v-else class="key-missing">Any</span>
            </td>
            <td>
              <span class="provider-label">{{ providerNameOf(m) }}</span>
            </td>
            <td>
              <span class="status-badge" :class="m.enabled ? 'enabled' : 'disabled'">
                {{ m.enabled ? 'Active' : 'Disabled' }}
              </span>
            </td>
            <td>{{ new Date(m.createdAt).toLocaleString() }}</td>
            <td>
              <div class="action-group">
                <button
                  class="btn-action"
                  :disabled="updatingId === m.id"
                  @click="toggleModel(m)"
                >
                  {{ updatingId === m.id ? '…' : (m.enabled ? 'Disable' : 'Enable') }}
                </button>
                <button
                  class="btn-action"
                  :disabled="updatingId === m.id"
                  @click="openEditForm(m)"
                >
                  Edit
                </button>
                <button
                  class="btn-action danger"
                  :disabled="deletingId === m.id"
                  @click="deleteModel(m)"
                >
                  {{ deletingId === m.id ? '…' : 'Delete' }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create / Edit modal -->
    <div v-if="showForm" class="modal-backdrop" role="dialog" aria-modal="true" @click.self="showForm = false">
      <div class="modal">
        <div class="modal-header">
          <h2>{{ formTitle }}</h2>
          <button class="modal-close" aria-label="Close" @click="showForm = false">×</button>
        </div>

        <div v-if="formError" class="form-error" role="alert">{{ formError }}</div>

        <form class="model-form" @submit.prevent="saveModel">
          <label class="field">
            <span class="field-label">Provider</span>
            <select v-model="form.providerId" class="field-input" required>
              <option value="" disabled>Select provider…</option>
              <option
                v-for="opt in providerOptions"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">Display name</span>
            <input
              v-model="form.name"
              class="field-input"
              type="text"
              placeholder="Seedance 2.5"
              maxlength="255"
              required
            />
          </label>

          <label class="field">
            <span class="field-label">External model ID</span>
            <input
              v-model="form.modelId"
              class="field-input"
              type="text"
              placeholder="doubao-seedance-2-5-260628"
              maxlength="255"
              required
            />
          </label>

          <label class="field">
            <span class="field-label">Capability / media type</span>
            <select v-model="form.capability" class="field-input">
              <option
                v-for="opt in capabilityOptions"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
          </label>

          <div class="field">
            <span class="field-label">Supported job types</span>
            <div class="checkbox-row">
              <label
                v-for="opt in jobTypeOptions"
                :key="opt.value"
                class="checkbox-field"
              >
                <input
                  type="checkbox"
                  :checked="form.jobTypes.includes(opt.value)"
                  @change="toggleJobType(opt.value)"
                />
                <span>{{ opt.label }}</span>
              </label>
            </div>
          </div>

          <label class="checkbox-field">
            <input v-model="form.enabled" type="checkbox" />
            <span>Enabled</span>
          </label>

          <div class="form-actions">
            <button type="button" class="btn-secondary" @click="showForm = false">Cancel</button>
            <button type="submit" class="btn-primary" :disabled="formSaving">
              {{ formSaving ? 'Saving…' : (formMode === 'create' ? 'Create Model' : 'Save Changes') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.admin-page {
  max-width: 1200px;
}
.eyebrow {
  color: #d35b3e;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 0.5rem;
}
.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.6rem;
  color: #ffffff;
}
.lede {
  color: #cfd6db;
  max-width: 65ch;
  margin: 0;
}
.actions-row {
  display: flex;
  gap: 0.6rem;
}
.btn-secondary {
  background: #1a2128;
  border: 1px solid #2a323b;
  color: #e6e9ec;
  padding: 0.45rem 0.9rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}
.btn-secondary:hover:not(:disabled) {
  background: #222b34;
  border-color: #d35b3e;
}
.btn-primary {
  background: #d35b3e;
  border: 1px solid #d35b3e;
  color: #ffffff;
  padding: 0.45rem 0.9rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 700;
}
.btn-primary:hover:not(:disabled) {
  background: #e06a4c;
}
.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.status-msg {
  padding: 1rem;
  background: #1a2128;
  border-radius: 6px;
  color: #cfd6db;
  margin-bottom: 1.5rem;
}
.status-msg.error {
  border-left: 4px solid #d35b3e;
  color: #ff8a70;
}
.empty-state {
  padding: 2.5rem;
  text-align: center;
  background: #1a2128;
  border: 1px dashed #2a323b;
  border-radius: 6px;
  color: #8b949e;
}
.empty-hint {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: #6b7682;
}
.table-container {
  overflow-x: auto;
  border: 1px solid #2a323b;
  border-radius: 6px;
  background: #141a20;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.9rem;
}
.data-table th {
  background: #1a2128;
  color: #8b949e;
  font-weight: 600;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #2a323b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.75rem;
}
.data-table td {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #1f272f;
  color: #cfd6db;
  vertical-align: middle;
}
.data-table tbody tr:hover {
  background: #1a2128;
}
.primary-cell {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.primary-cell strong {
  color: #ffffff;
}
code {
  background: #1f272f;
  color: #81d4fa;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-size: 0.8rem;
  width: fit-content;
}
.subtext {
  font-size: 0.75rem;
  color: #6b7682;
  font-family: monospace;
}
.cap-badge {
  display: inline-block;
  background: #232035;
  color: #ce93d8;
  border: 1px solid #6a1b9a;
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.job-types {
  font-size: 0.78rem;
  color: #9aa4ae;
  font-family: monospace;
}
.key-missing {
  color: #8b949e;
  font-size: 0.8rem;
  font-style: italic;
}
.provider-label {
  color: #e6e9ec;
  font-weight: 600;
}
.status-badge {
  display: inline-block;
  padding: 0.2rem 0.55rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.status-badge.enabled {
  background: #132e22;
  color: #81c784;
  border: 1px solid #2e7d32;
}
.status-badge.disabled {
  background: #212529;
  color: #8b949e;
  border: 1px solid #37474f;
}
.action-group {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.btn-action {
  background: #1f272f;
  border: 1px solid #2a323b;
  color: #e6e9ec;
  padding: 0.35rem 0.65rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}
.btn-action:hover:not(:disabled) {
  border-color: #d35b3e;
  background: #2a3440;
}
.btn-action.danger:hover:not(:disabled) {
  border-color: #d32f2f;
  color: #ff8a70;
}
.btn-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}
.modal {
  background: #141a20;
  border: 1px solid #2a323b;
  border-radius: 8px;
  width: 100%;
  max-width: 520px;
  max-height: 90vh;
  overflow-y: auto;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #2a323b;
}
.modal-header h2 {
  margin: 0;
  font-size: 1.15rem;
  color: #ffffff;
}
.modal-close {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 1.4rem;
  cursor: pointer;
  line-height: 1;
}
.modal-close:hover {
  color: #ffffff;
}
.model-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #9aa4ae;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.field-input {
  background: #1a2128;
  border: 1px solid #2a323b;
  border-radius: 4px;
  color: #e6e9ec;
  padding: 0.5rem 0.65rem;
  font-size: 0.9rem;
  outline: none;
}
.field-input:focus {
  border-color: #d35b3e;
}
select.field-input {
  cursor: pointer;
}
.checkbox-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
}
.checkbox-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #cfd6db;
  font-size: 0.85rem;
  cursor: pointer;
}
.checkbox-field input {
  accent-color: #d35b3e;
  width: 16px;
  height: 16px;
}
.form-error {
  margin: 1.25rem 1.25rem 0;
  padding: 0.65rem 0.85rem;
  background: #2a1a1a;
  border-left: 3px solid #d32f2f;
  border-radius: 4px;
  color: #ff8a70;
  font-size: 0.85rem;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
</style>
