<script setup lang="ts">
import { APP_NAME, type AdminOverviewStats } from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminOverviewPage" });

const api = useApi();
const stats = ref<AdminOverviewStats | null>(null);
const loading = ref(true);
const error = ref("");

async function loadStats() {
  loading.value = true;
  error.value = "";
  try {
    stats.value = await api.get<AdminOverviewStats>("/admin/overview");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Failed to load admin overview.";
  } finally {
    loading.value = false;
  }
}

onMounted(loadStats);

const sections = [
  { label: "Users", to: "/admin/users", desc: "Manage registered user accounts and roles" },
  { label: "Projects", to: "/admin/projects", desc: "View and manage all user projects" },
  { label: "Providers", to: "/admin/providers", desc: "Configure AI generation providers" },
  { label: "Models", to: "/admin/models", desc: "Manage AI models and capabilities" },
  { label: "Jobs", to: "/admin/jobs", desc: "Monitor and control generation jobs" },
  { label: "Usage", to: "/admin/usage", desc: "Resource usage statistics (Stub)" },
  { label: "Quotas", to: "/admin/quotas", desc: "Project quotas and limits (Stub)" },
  { label: "Storage", to: "/admin/storage", desc: "Media storage metrics (Stub)" },
  { label: "Settings", to: "/admin/settings", desc: "System configuration (Stub)" },
  { label: "Audit logs", to: "/admin/audit", desc: "Administrative audit trail (Stub)" },
  { label: "Security", to: "/admin/security", desc: "Authentication and session security (Stub)" },
];
</script>

<template>
  <section class="admin-overview">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <h1>Control Plane Overview</h1>
    <p class="lede">
      System-wide operational metrics, AI generation status, and administrative services.
    </p>

    <div v-if="loading" class="status-msg" role="status">Loading metrics…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>

    <div v-else-if="stats" class="metrics-grid">
      <NuxtLink to="/admin/users" class="metric-card">
        <span class="metric-title">Users</span>
        <span class="metric-value">{{ stats.usersCount }}</span>
        <span class="metric-sub">{{ stats.adminUsersCount }} admin{{ stats.adminUsersCount === 1 ? '' : 's' }}</span>
      </NuxtLink>

      <NuxtLink to="/admin/projects" class="metric-card">
        <span class="metric-title">Projects</span>
        <span class="metric-value">{{ stats.projectsCount }}</span>
        <span class="metric-sub">Total workspaces</span>
      </NuxtLink>

      <NuxtLink to="/admin/providers" class="metric-card">
        <span class="metric-title">AI Providers</span>
        <span class="metric-value">{{ stats.enabledProvidersCount }} / {{ stats.providersCount }}</span>
        <span class="metric-sub">Enabled providers</span>
      </NuxtLink>

      <NuxtLink to="/admin/models" class="metric-card">
        <span class="metric-title">AI Models</span>
        <span class="metric-value">{{ stats.enabledModelsCount }} / {{ stats.modelsCount }}</span>
        <span class="metric-sub">Enabled models</span>
      </NuxtLink>

      <NuxtLink to="/admin/jobs" class="metric-card">
        <span class="metric-title">Generation Jobs</span>
        <span class="metric-value">{{ stats.jobsCount }}</span>
        <span class="metric-sub">Total jobs dispatched</span>
      </NuxtLink>
    </div>

    <div v-if="stats" class="jobs-breakdown">
      <h2>Job Status Breakdown</h2>
      <div class="status-chips">
        <span class="chip queued">Queued: {{ stats.jobsByStatus.queued || 0 }}</span>
        <span class="chip submitted">Submitted: {{ stats.jobsByStatus.submitted || 0 }}</span>
        <span class="chip processing">Processing: {{ stats.jobsByStatus.processing || 0 }}</span>
        <span class="chip downloading">Downloading: {{ stats.jobsByStatus.downloading || 0 }}</span>
        <span class="chip completed">Completed: {{ stats.jobsByStatus.completed || 0 }}</span>
        <span class="chip failed">Failed: {{ stats.jobsByStatus.failed || 0 }}</span>
        <span class="chip cancelled">Cancelled: {{ stats.jobsByStatus.cancelled || 0 }}</span>
      </div>
    </div>

    <h2>Administrative Sections</h2>
    <ul class="sections-grid">
      <li v-for="section in sections" :key="section.to">
        <NuxtLink :to="section.to" class="section-link">
          <span class="section-name">{{ section.label }}</span>
          <span class="section-desc">{{ section.desc }}</span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.admin-overview {
  max-width: 1200px;
}
.eyebrow {
  color: #d35b3e;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 0.5rem;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.6rem;
  color: #ffffff;
}
h2 {
  font-size: 1.2rem;
  margin: 2rem 0 1rem;
  color: #e6e9ec;
}
.lede {
  color: #cfd6db;
  max-width: 65ch;
  margin: 0 0 1.5rem;
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
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.metric-card {
  display: flex;
  flex-direction: column;
  background: #1a2128;
  border: 1px solid #2a323b;
  border-radius: 8px;
  padding: 1.25rem 1rem;
  text-decoration: none;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.metric-card:hover {
  border-color: #d35b3e;
  transform: translateY(-1px);
}
.metric-title {
  font-size: 0.85rem;
  color: #8b949e;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.5rem;
}
.metric-value {
  font-size: 1.8rem;
  font-weight: 700;
  color: #ffffff;
  margin-bottom: 0.25rem;
}
.metric-sub {
  font-size: 0.8rem;
  color: #cfd6db;
}
.jobs-breakdown {
  background: #141a20;
  border: 1px solid #2a323b;
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 1.5rem;
}
.jobs-breakdown h2 {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
}
.status-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.chip {
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
}
.chip.queued { background: #263238; color: #b0bec5; border: 1px solid #37474f; }
.chip.submitted { background: #1a2c3a; color: #81d4fa; border: 1px solid #29b6f6; }
.chip.processing { background: #2e2814; color: #ffe082; border: 1px solid #ffb300; }
.chip.downloading { background: #2b1d3a; color: #ce93d8; border: 1px solid #ab47bc; }
.chip.completed { background: #132e22; color: #81c784; border: 1px solid #2e7d32; }
.chip.failed { background: #331518; color: #ef9a9a; border: 1px solid #c62828; }
.chip.cancelled { background: #212529; color: #9e9e9e; border: 1px solid #424242; }

.sections-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.75rem;
}
.section-link {
  display: flex;
  flex-direction: column;
  background: #1a2128;
  border: 1px solid #2a323b;
  border-radius: 6px;
  padding: 0.9rem 1rem;
  text-decoration: none;
  height: 100%;
  box-sizing: border-box;
}
.section-link:hover {
  background: #1f272f;
  border-color: #d35b3e;
}
.section-name {
  color: #ffffff;
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 0.25rem;
}
.section-desc {
  color: #8b949e;
  font-size: 0.8rem;
}
</style>
