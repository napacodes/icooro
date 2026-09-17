<script setup lang="ts">
import { APP_NAME, type AiProvider } from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminProvidersPage" });

const api = useApi();
const providers = ref<AiProvider[]>([]);
const loading = ref(true);
const error = ref("");
const updatingId = ref<string | null>(null);

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

onMounted(loadProviders);
</script>

<template>
  <section class="admin-page">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <div class="title-row">
      <div>
        <h1>AI Providers</h1>
        <p class="lede">Registered generation backend adapters and operational availability.</p>
      </div>
      <button class="btn-secondary" :disabled="loading" @click="loadProviders">Refresh</button>
    </div>

    <div v-if="loading" class="status-msg" role="status">Loading AI providers…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>
    <div v-else-if="providers.length === 0" class="empty-state">No AI providers configured.</div>

    <div v-else class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Type</th>
            <th>Status</th>
            <th>Created</th>
            <th>Action</th>
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
            <td>
              <span class="status-badge" :class="p.enabled ? 'enabled' : 'disabled'">
                {{ p.enabled ? 'Active' : 'Disabled' }}
              </span>
            </td>
            <td>{{ new Date(p.createdAt).toLocaleString() }}</td>
            <td>
              <button
                class="btn-action"
                :disabled="updatingId === p.id"
                @click="toggleProvider(p)"
              >
                {{ updatingId === p.id ? 'Updating…' : (p.enabled ? 'Disable' : 'Enable') }}
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
}
.primary-cell strong {
  color: #ffffff;
}
.subtext {
  font-size: 0.75rem;
  color: #6b7682;
  font-family: monospace;
}
code {
  background: #1f272f;
  color: #81d4fa;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-size: 0.85rem;
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
