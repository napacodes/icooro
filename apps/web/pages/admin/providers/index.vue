<script setup lang="ts">
import {
  APP_NAME,
  type AiProvider,
  type ProviderTypeDescriptor,
} from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminProvidersPage" });

const api = useApi();

const providers = ref<AiProvider[]>([]);
const adapterTypes = ref<ProviderTypeDescriptor[]>([]);
const loading = ref(true);
const error = ref("");
const updatingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);

// --- Provider create/edit form -------------------------------------------
const showForm = ref(false);
const formMode = ref<"create" | "edit">("create");
const formSaving = ref(false);
const formError = ref("");
const form = reactive({
  id: "",
  name: "",
  providerType: "",
  baseUrl: "",
  apiKey: "",
  enabled: true,
});
const apiKeyTouched = ref(false);

const formTitle = computed(() =>
  formMode.value === "create" ? "Add AI Provider" : "Edit AI Provider",
);

function resetForm() {
  form.id = "";
  form.name = "";
  form.providerType = "";
  form.baseUrl = "";
  form.apiKey = "";
  form.enabled = true;
  apiKeyTouched.value = false;
  formError.value = "";
}

function openCreateForm() {
  resetForm();
  formMode.value = "create";
  showForm.value = true;
}

function openEditForm(provider: AiProvider) {
  resetForm();
  formMode.value = "edit";
  form.id = provider.id;
  form.name = provider.name;
  form.providerType = provider.providerType;
  form.baseUrl = provider.baseUrl ?? "";
  form.enabled = provider.enabled;
  showForm.value = true;
}

/**
 * Provider/adapter types the Control Plane can configure. The API returns
 * the whole provider architecture (C6.7.1). As of C6.7.2.3 every type is
 * implemented and selectable: ChatFire (C5.1, video), OpenAI (C6.7.2.1),
 * Google Gemini (C6.7.2.2) and custom OpenAI-compatible (C6.7.2.3, both
 * text). Types flagged `adapterAvailable: false` would be listed disabled.
 */
const adapterTypeOptions = computed(() =>
  adapterTypes.value.map((t) => ({
    label: t.adapterAvailable ? `${t.name} (${t.providerType})` : `${t.name} (${t.providerType}) — adapter coming soon`,
    value: t.providerType,
    disabled: !t.adapterAvailable,
  })),
);

// --- Data loading ---------------------------------------------------------

async function loadProviders() {
  loading.value = true;
  error.value = "";
  try {
    providers.value = await api.get<AiProvider[]>("/admin/providers");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Failed to load providers.";
  } finally {
    loading.value = false;
  }
}

async function loadAdapterTypes() {
  try {
    adapterTypes.value = await api.get<ProviderTypeDescriptor[]>("/admin/provider-types");
  } catch {
    // Non-fatal: the type selector simply falls back to free text.
    adapterTypes.value = [];
  }
}

async function toggleProvider(provider: AiProvider) {
  updatingId.value = provider.id;
  try {
    const updated = await api.patch<AiProvider>(`/admin/providers/${provider.id}`, {
      enabled: !provider.enabled,
    });
    const idx = providers.value.findIndex((p) => p.id === provider.id);
    if (idx !== -1) {
      providers.value[idx] = updated;
    }
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : "Failed to update provider.");
  } finally {
    updatingId.value = null;
  }
}

async function saveProvider() {
  if (!form.name.trim() || !form.providerType) {
    formError.value = "Name and provider type are required.";
    return;
  }
  formSaving.value = true;
  formError.value = "";
  try {
    if (formMode.value === "create") {
      const created = await api.post<AiProvider>("/admin/providers", {
        name: form.name.trim(),
        providerType: form.providerType,
        baseUrl: form.baseUrl.trim() || null,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        enabled: form.enabled,
      });
      providers.value = [...providers.value, created];
    } else {
      // On edit, send apiKey only when the admin typed a new one; omitting
      // it keeps the stored key untouched.
      const patch: Record<string, unknown> = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim() || null,
        enabled: form.enabled,
      };
      if (apiKeyTouched.value && form.apiKey.trim()) {
        patch.apiKey = form.apiKey.trim();
      }
      const updated = await api.patch<AiProvider>(`/admin/providers/${form.id}`, patch);
      const idx = providers.value.findIndex((p) => p.id === form.id);
      if (idx !== -1) {
        providers.value[idx] = updated;
      }
    }
    showForm.value = false;
    resetForm();
  } catch (err: unknown) {
    formError.value = err instanceof Error ? err.message : "Failed to save provider.";
  } finally {
    formSaving.value = false;
  }
}

async function deleteProvider(provider: AiProvider) {
  if (
    !confirm(
      `Delete provider "${provider.name}"? This is only allowed when no models or generation jobs reference it.`,
    )
  ) {
    return;
  }
  deletingId.value = provider.id;
  try {
    await api.delete(`/admin/providers/${provider.id}`);
    providers.value = providers.value.filter((p) => p.id !== provider.id);
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : "Failed to delete provider.");
  } finally {
    deletingId.value = null;
  }
}

onMounted(() => {
  loadProviders();
  loadAdapterTypes();
});
</script>

<template>
  <section class="admin-page">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <div class="title-row">
      <div>
        <h1>AI Providers</h1>
        <p class="lede">
          Database-driven generation backends. Configure an adapter, its base URL, and an API key;
          the key is stored encrypted and only ever shown masked.
        </p>
      </div>
      <div class="actions-row">
        <button class="btn-secondary" :disabled="loading" @click="loadProviders">Refresh</button>
        <button class="btn-primary" @click="openCreateForm">+ Add Provider</button>
      </div>
    </div>

    <div v-if="loading" class="status-msg" role="status">Loading AI providers…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>
    <div v-else-if="providers.length === 0" class="empty-state">
      <p>No AI providers configured.</p>
      <p class="empty-hint">Add a provider to make it available to project generation.</p>
    </div>

    <div v-else class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Type</th>
            <th>Base URL</th>
            <th>API Key</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in providers" :key="p.id">
            <td class="primary-cell">
              <strong>{{ p.name }}</strong>
              <span class="subtext">{{ p.id }}</span>
            </td>
            <td>
              <code>{{ p.providerType }}</code>
            </td>
            <td class="mono-cell">{{ p.baseUrl || '—' }}</td>
            <td>
              <span v-if="p.hasApiKey" class="key-badge">🔒 {{ p.apiKeyMasked }}</span>
              <span v-else class="key-missing">Not configured</span>
            </td>
            <td>
              <span class="status-badge" :class="p.enabled ? 'enabled' : 'disabled'">
                {{ p.enabled ? 'Active' : 'Disabled' }}
              </span>
            </td>
            <td>{{ new Date(p.createdAt).toLocaleString() }}</td>
            <td>
              <div class="action-group">
                <button
                  class="btn-action"
                  :disabled="updatingId === p.id"
                  @click="toggleProvider(p)"
                >
                  {{ updatingId === p.id ? '…' : (p.enabled ? 'Disable' : 'Enable') }}
                </button>
                <button
                  class="btn-action"
                  :disabled="updatingId === p.id"
                  @click="openEditForm(p)"
                >
                  Edit
                </button>
                <button
                  class="btn-action danger"
                  :disabled="deletingId === p.id"
                  @click="deleteProvider(p)"
                >
                  {{ deletingId === p.id ? '…' : 'Delete' }}
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

        <form class="provider-form" @submit.prevent="saveProvider">
          <label class="field">
            <span class="field-label">Provider name</span>
            <input
              v-model="form.name"
              class="field-input"
              type="text"
              placeholder="ChatFire"
              maxlength="255"
              required
            />
          </label>

          <label class="field">
            <span class="field-label">Provider / adapter type</span>
            <select
              v-if="adapterTypeOptions.length > 0"
              v-model="form.providerType"
              class="field-input"
              :disabled="formMode === 'edit'"
              required
            >
              <option value="" disabled>Select adapter type…</option>
              <option
                v-for="opt in adapterTypeOptions"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <input
              v-else
              v-model="form.providerType"
              class="field-input"
              type="text"
              placeholder="chatfire"
              :disabled="formMode === 'edit'"
              maxlength="100"
              required
            />
          </label>

          <label class="field">
            <span class="field-label">Base URL</span>
            <input
              v-model="form.baseUrl"
              class="field-input"
              type="url"
              placeholder="https://api.chatfire.site"
              maxlength="500"
            />
          </label>

          <label class="field">
            <span class="field-label">
              API key
              <span v-if="formMode === 'edit'" class="field-hint">
                — leave blank to keep the stored key
              </span>
            </span>
            <input
              v-model="form.apiKey"
              class="field-input"
              type="password"
              autocomplete="off"
              :placeholder="formMode === 'edit' ? '•••••••• (unchanged)' : 'Enter API key'"
              @input="apiKeyTouched = true"
            />
          </label>

          <label class="checkbox-field">
            <input v-model="form.enabled" type="checkbox" />
            <span>Enabled</span>
          </label>

          <div class="form-actions">
            <button type="button" class="btn-secondary" @click="showForm = false">Cancel</button>
            <button type="submit" class="btn-primary" :disabled="formSaving">
              {{ formSaving ? 'Saving…' : (formMode === 'create' ? 'Create Provider' : 'Save Changes') }}
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
}
.primary-cell strong {
  color: #ffffff;
}
.subtext {
  font-size: 0.75rem;
  color: #6b7682;
  font-family: monospace;
}
.mono-cell {
  font-family: monospace;
  font-size: 0.8rem;
  color: #9aa4ae;
}
code {
  background: #1f272f;
  color: #81d4fa;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-size: 0.85rem;
}
.key-badge {
  display: inline-block;
  background: #1f272f;
  color: #ffd54f;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-family: monospace;
  border: 1px solid #3d3422;
}
.key-missing {
  color: #8b949e;
  font-size: 0.8rem;
  font-style: italic;
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
.provider-form {
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
.field-hint {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
  color: #6b7682;
  font-size: 0.75rem;
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
.field-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
select.field-input {
  cursor: pointer;
}
.checkbox-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #cfd6db;
  font-size: 0.9rem;
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
