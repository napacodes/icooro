<script setup lang="ts">
import { APP_NAME, type AdminProject } from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminProjectsPage" });

const api = useApi();
const projects = ref<AdminProject[]>([]);
const loading = ref(true);
const error = ref("");

async function loadProjects() {
  loading.value = true;
  error.value = "";
  try {
    projects.value = await api.get<AdminProject[]>("/admin/projects");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Failed to load projects.";
  } finally {
    loading.value = false;
  }
}

onMounted(loadProjects);
</script>

<template>
  <section class="admin-page">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <div class="title-row">
      <div>
        <h1>Projects</h1>
        <p class="lede">All storytelling projects and workspaces created across the system.</p>
      </div>
      <button class="btn-secondary" :disabled="loading" @click="loadProjects">Refresh</button>
    </div>

    <div v-if="loading" class="status-msg" role="status">Loading projects…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>
    <div v-else-if="projects.length === 0" class="empty-state">No projects found in the system.</div>

    <div v-else class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Owner</th>
            <th>Status</th>
            <th>Created</th>
            <th>Workspace</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id">
            <td class="primary-cell">
              <strong>{{ p.name }}</strong>
              <span v-if="p.description" class="desc-text">{{ p.description }}</span>
              <span class="subtext">{{ p.id }}</span>
            </td>
            <td>
              <div class="owner-cell">
                <span class="owner-name">{{ p.ownerName || 'Unknown user' }}</span>
                <span class="subtext">{{ p.ownerEmail || p.ownerId }}</span>
              </div>
            </td>
            <td>
              <span class="status-badge">{{ p.status }}</span>
            </td>
            <td>{{ new Date(p.createdAt).toLocaleString() }}</td>
            <td>
              <NuxtLink :to="`/app/projects/${p.id}`" class="link-btn">
                Open workspace
              </NuxtLink>
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
.desc-text {
  font-size: 0.8rem;
  color: #a0aec0;
  margin-top: 0.15rem;
}
.subtext {
  font-size: 0.75rem;
  color: #6b7682;
  font-family: monospace;
}
.owner-cell {
  display: flex;
  flex-direction: column;
}
.owner-name {
  color: #e6e9ec;
  font-weight: 600;
}
.status-badge {
  background: #1f272f;
  color: #8b949e;
  border: 1px solid #2a323b;
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.link-btn {
  color: #81d4fa;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.85rem;
}
.link-btn:hover {
  text-decoration: underline;
  color: #4fc3f7;
}
</style>
