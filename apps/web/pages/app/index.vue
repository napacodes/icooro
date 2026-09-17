<script setup lang="ts">
import { APP_NAME, type Project, type PublicUser } from "@icooro/shared";

definePageMeta({ layout: "app" });
defineOptions({ name: "UserDashboardPage" });

const auth = useAuth();
const api = useApi();
const user = computed<PublicUser | null>(() => auth.user.value);

const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref("");

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (status.toLowerCase()) {
    case "active":
    case "completed":
    case "ready":
      return "success";
    case "in_progress":
    case "processing":
      return "info";
    case "draft":
    case "pending":
      return "warning";
    case "archived":
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

const recentProjects = computed(() => projects.value.slice(0, 4));

async function loadDashboard() {
  loading.value = true;
  error.value = "";
  try {
    projects.value = await api.get<Project[]>("/projects");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Unable to load dashboard data.";
  } finally {
    loading.value = false;
  }
}

onMounted(loadDashboard);
</script>

<template>
  <section class="dashboard-page">
    <header class="welcome-header">
      <div class="welcome-text">
        <p class="eyebrow">{{ APP_NAME }} Studio</p>
        <h1>Dashboard</h1>
        <p v-if="user" class="muted">
          Welcome back, <strong>{{ user.name }}</strong>. Manage your creative workspaces and production assets.
        </p>
        <p v-else class="muted">Loading workspace…</p>
      </div>
      <div class="header-actions">
        <NuxtLink to="/app/projects/new" class="btn-primary">New project</NuxtLink>
      </div>
    </header>

    <div v-if="loading" class="state-container">
      <LoadingState label="Loading your dashboard…" />
    </div>

    <div v-else-if="error" class="state-container">
      <ErrorBanner :message="error" />
      <BaseButton variant="secondary" size="sm" class="retry-btn" @click="loadDashboard">Retry</BaseButton>
    </div>

    <div v-else-if="projects.length === 0" class="empty-wrap">
      <EmptyState
        title="No projects yet"
        description="You haven't created any storytelling projects yet. Start by setting up your first production workspace to plan episodes, scenes, and media assets."
      >
        <NuxtLink to="/app/projects/new" class="btn-primary">Create your first project</NuxtLink>
      </EmptyState>
    </div>

    <div v-else class="dashboard-content">
      <div class="summary-cards">
        <div class="summary-card">
          <span class="card-label">Total Projects</span>
          <span class="card-value">{{ projects.length }}</span>
          <NuxtLink to="/app/projects" class="card-link">View all projects →</NuxtLink>
        </div>
        <div class="summary-card action-card">
          <span class="card-label">Start Something New</span>
          <p class="action-desc">Launch a fresh workspace for your next production.</p>
          <NuxtLink to="/app/projects/new" class="btn-primary btn-sm">Create project</NuxtLink>
        </div>
      </div>

      <div class="recent-section">
        <div class="section-heading">
          <h2>Recent Projects</h2>
          <NuxtLink to="/app/projects" class="view-all-link">View all ({{ projects.length }})</NuxtLink>
        </div>

        <div class="projects-grid">
          <article v-for="p in recentProjects" :key="p.id" class="project-card">
            <div class="card-header">
              <h3 class="project-title">{{ p.name }}</h3>
              <StatusPill :tone="statusTone(p.status)">{{ p.status }}</StatusPill>
            </div>
            <p v-if="p.description" class="project-desc">{{ p.description }}</p>
            <p v-else class="project-desc muted-placeholder">No description provided.</p>
            <div class="card-footer">
              <span class="date-text">Created {{ new Date(p.createdAt).toLocaleDateString() }}</span>
              <NuxtLink :to="`/app/projects/${p.id}`" class="open-link">Open workspace →</NuxtLink>
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dashboard-page {
  max-width: 1080px;
}
.welcome-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 2rem;
}
.eyebrow {
  color: #176b65;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.8rem;
  margin: 0 0 0.35rem;
}
h1 {
  margin: 0 0 0.35rem;
  font-size: 1.8rem;
  color: #17212b;
}
.muted {
  color: #52606d;
  margin: 0;
  font-size: 1rem;
}
.header-actions {
  display: flex;
  gap: 0.75rem;
}
.btn-primary {
  display: inline-block;
  background: #176b65;
  color: #fff;
  padding: 0.6rem 1rem;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 700;
  font-size: 0.9rem;
  transition: background-color 0.15s ease;
}
.btn-primary:hover {
  background: #134d48;
}
.btn-sm {
  padding: 0.45rem 0.8rem;
  font-size: 0.85rem;
}
.state-container {
  margin: 2rem 0;
}
.retry-btn {
  margin-top: 0.75rem;
}
.empty-wrap {
  margin: 1.5rem 0;
}
.dashboard-content {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}
.summary-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}
.summary-card {
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
}
.card-label {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
  color: #68777c;
  margin-bottom: 0.5rem;
}
.card-value {
  font-size: 2.2rem;
  font-weight: 800;
  color: #17212b;
  margin-bottom: 0.5rem;
}
.card-link {
  color: #176b65;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9rem;
  margin-top: auto;
}
.card-link:hover {
  text-decoration: underline;
}
.action-card {
  background: #f0f7f6;
  border-color: #b9cdca;
}
.action-desc {
  color: #52606d;
  margin: 0 0 1rem;
  font-size: 0.95rem;
}
.recent-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-heading h2 {
  margin: 0;
  font-size: 1.25rem;
  color: #17212b;
}
.view-all-link {
  color: #176b65;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9rem;
}
.view-all-link:hover {
  text-decoration: underline;
}
.projects-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}
.project-card {
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}
.project-card:hover {
  border-color: #176b65;
  box-shadow: 0 4px 12px rgba(23, 107, 101, 0.08);
}
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}
.project-title {
  margin: 0;
  font-size: 1.05rem;
  color: #17212b;
}
.project-desc {
  color: #52606d;
  font-size: 0.9rem;
  margin: 0 0 1.25rem;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.muted-placeholder {
  color: #8b949e;
  font-style: italic;
}
.card-footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 0.75rem;
  border-top: 1px solid #eef1f5;
}
.date-text {
  font-size: 0.8rem;
  color: #68777c;
}
.open-link {
  color: #176b65;
  text-decoration: none;
  font-weight: 700;
  font-size: 0.85rem;
}
.open-link:hover {
  text-decoration: underline;
}
@media (max-width: 720px) {
  .welcome-header {
    flex-direction: column;
  }
  .summary-cards,
  .projects-grid {
    grid-template-columns: 1fr;
  }
}
</style>
