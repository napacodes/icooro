<script setup lang="ts">
import { APP_NAME, type AiModel } from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminModelsPage" });

const api = useApi();
const models = ref<AiModel[]>([]);
const loading = ref(true);
const error = ref("");
const updatingId = ref<string | null>(null);

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

onMounted(loadModels);
</script>

<template>
  <section class="admin-page">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <div class="title-row">
      <div>
        <h1>AI Models</h1>
        <p class="lede">Configured generation models, capabilities, and provider bindings.</p>
      </div>
      <button class="btn-secondary" :disabled="loading" @click="loadModels">Refresh</button>
    </div>

    <div v-if="loading" class="status-msg" role="status">Loading AI models…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>
    <div v-else-if="models.length === 0" class="empty-state">No AI models configured in the system.</div>

    <div v-else class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Capability</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Created</th>
            <th>Action</th>
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
              <span class="provider-label">{{ m.providerName || m.providerId }}</span>
            </td>
            <td>
              <span class="status-badge" :class="m.enabled ? 'enabled' : 'disabled'">
                {{ m.enabled ? 'Active' : 'Disabled' }}
              </span>
            </td>
            <td>{{ new Date(m.createdAt).toLocaleString() }}</td>
            <td>
              <button
                class="btn-action"
                :disabled="updatingId === m.id"
                @click="toggleModel(m)"
              >
                {{ updatingId === m.id ? 'Updating…' : (m.enabled ? 'Disable' : 'Enable') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
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
.btn-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
