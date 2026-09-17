<script setup lang="ts">
import { APP_NAME, type AdminJob, type JobStatus } from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminJobsPage" });

const api = useApi();
const jobs = ref<AdminJob[]>([]);
const loading = ref(true);
const error = ref("");
const statusFilter = ref<string>("");
const cancellingId = ref<string | null>(null);

const filterOptions = [
  { label: "All", value: "" },
  { label: "Queued", value: "queued" },
  { label: "Submitted", value: "submitted" },
  { label: "Processing", value: "processing" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
];

async function loadJobs() {
  loading.value = true;
  error.value = "";
  try {
    const query = statusFilter.value ? `?status=${statusFilter.value}` : "";
    jobs.value = await api.get<AdminJob[]>(`/admin/jobs${query}`);
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Failed to load generation jobs.";
  } finally {
    loading.value = false;
  }
}

function setFilter(status: string) {
  statusFilter.value = status;
  loadJobs();
}

async function cancelJob(job: AdminJob) {
  if (!confirm(`Are you sure you want to cancel job ${job.id}?`)) return;
  cancellingId.value = job.id;
  try {
    const updated = await api.post<AdminJob>(`/admin/jobs/${job.id}/cancel`);
    const idx = jobs.value.findIndex((j) => j.id === job.id);
    if (idx !== -1) {
      jobs.value[idx] = { ...jobs.value[idx], ...updated };
    }
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : "Failed to cancel job.");
  } finally {
    cancellingId.value = null;
  }
}

function canCancel(status: JobStatus): boolean {
  return status === "queued" || status === "submitted" || status === "processing";
}

onMounted(loadJobs);
</script>

<template>
  <section class="admin-page">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <div class="title-row">
      <div>
        <h1>Generation Jobs</h1>
        <p class="lede">Monitor, inspect, and cancel AI generation jobs across the platform.</p>
      </div>
      <button class="btn-secondary" :disabled="loading" @click="loadJobs">Refresh</button>
    </div>

    <div class="filter-tabs">
      <button
        v-for="tab in filterOptions"
        :key="tab.value"
        class="tab-btn"
        :class="{ active: statusFilter === tab.value }"
        @click="setFilter(tab.value)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="loading" class="status-msg" role="status">Loading generation jobs…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>
    <div v-else-if="jobs.length === 0" class="empty-state">No generation jobs found.</div>

    <div v-else class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Project</th>
            <th>Type</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Created</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="j in jobs" :key="j.id">
            <td class="primary-cell">
              <span class="subtext">{{ j.id }}</span>
              <span v-if="j.prompt" class="prompt-text" :title="j.prompt">{{ j.prompt }}</span>
              <span v-if="j.error" class="error-text" :title="j.error">Error: {{ j.error }}</span>
            </td>
            <td>
              <span class="project-name">{{ j.projectName || j.projectId }}</span>
            </td>
            <td>
              <span class="type-badge">{{ j.jobType }}</span>
            </td>
            <td>
              <span class="status-badge" :class="j.status">{{ j.status }}</span>
            </td>
            <td>
              <div class="progress-wrapper">
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: `${j.progress || 0}%` }" />
                </div>
                <span class="progress-num">{{ j.progress || 0 }}%</span>
              </div>
            </td>
            <td>{{ new Date(j.createdAt).toLocaleString() }}</td>
            <td>
              <button
                v-if="canCancel(j.status)"
                class="btn-cancel"
                :disabled="cancellingId === j.id"
                @click="cancelJob(j)"
              >
                {{ cancellingId === j.id ? 'Cancelling…' : 'Cancel' }}
              </button>
              <span v-else class="muted-dash">—</span>
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
  margin-bottom: 1rem;
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
.filter-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-bottom: 1.25rem;
}
.tab-btn {
  background: #141a20;
  border: 1px solid #2a323b;
  color: #8b949e;
  padding: 0.35rem 0.75rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.8rem;
}
.tab-btn:hover {
  color: #e6e9ec;
  border-color: #37474f;
}
.tab-btn.active {
  background: #d35b3e;
  border-color: #d35b3e;
  color: #ffffff;
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
  max-width: 280px;
}
.subtext {
  font-size: 0.75rem;
  color: #6b7682;
  font-family: monospace;
}
.prompt-text {
  font-size: 0.8rem;
  color: #cfd6db;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.error-text {
  font-size: 0.75rem;
  color: #ef9a9a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.project-name {
  color: #e6e9ec;
  font-weight: 600;
}
.type-badge {
  display: inline-block;
  background: #1a2128;
  color: #90caf9;
  border: 1px solid #1e3a5f;
  border-radius: 4px;
  padding: 0.2rem 0.45rem;
  font-size: 0.75rem;
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
.status-badge.queued { background: #263238; color: #b0bec5; border: 1px solid #37474f; }
.status-badge.submitted { background: #1a2c3a; color: #81d4fa; border: 1px solid #29b6f6; }
.status-badge.processing { background: #2e2814; color: #ffe082; border: 1px solid #ffb300; }
.status-badge.downloading { background: #2b1d3a; color: #ce93d8; border: 1px solid #ab47bc; }
.status-badge.completed { background: #132e22; color: #81c784; border: 1px solid #2e7d32; }
.status-badge.failed { background: #331518; color: #ef9a9a; border: 1px solid #c62828; }
.status-badge.cancelled { background: #212529; color: #9e9e9e; border: 1px solid #424242; }

.progress-wrapper {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.progress-bar {
  width: 60px;
  height: 6px;
  background: #2a323b;
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: #d35b3e;
  border-radius: 3px;
}
.progress-num {
  font-size: 0.75rem;
  color: #8b949e;
}
.btn-cancel {
  background: #331518;
  border: 1px solid #c62828;
  color: #ef9a9a;
  padding: 0.35rem 0.65rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}
.btn-cancel:hover:not(:disabled) {
  background: #491d22;
  color: #ffcdd2;
}
.btn-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.muted-dash {
  color: #6b7682;
}
</style>
