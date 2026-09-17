<script setup lang="ts">
import { APP_NAME, type Project } from "@icooro/shared";

definePageMeta({ layout: "app" });
defineOptions({ name: "UserProjectsPage" });

const api = useApi();
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

async function loadProjects() {
  loading.value = true;
  error.value = "";
  try {
    projects.value = await api.get<Project[]>("/projects");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Unable to load projects.";
  } finally {
    loading.value = false;
  }
}

onMounted(loadProjects);
</script>

<template>
  <section class="projects-page">
    <header class="header">
      <div>
        <p class="eyebrow">{{ APP_NAME }} Studio</p>
        <h1>Projects</h1>
        <p class="muted">Your storytelling workspaces and creative productions.</p>
      </div>
      <NuxtLink to="/app/projects/new" class="btn-primary">New project</NuxtLink>
    </header>

    <div v-if="loading" class="state-container">
      <LoadingState label="Loading your projects…" />
    </div>

    <div v-else-if="error" class="state-container">
      <ErrorBanner :message="error" />
      <BaseButton variant="secondary" size="sm" class="retry-btn" @click="loadProjects">Retry</BaseButton>
    </div>

    <div v-else-if="projects.length === 0" class="empty-container">
      <EmptyState
        title="No projects yet"
        description="You haven't created any storytelling projects yet. Create your first project to begin planning episodes, scenes, and media assets."
      >
        <NuxtLink to="/app/projects/new" class="btn-primary">Create your first project</NuxtLink>
      </EmptyState>
    </div>

    <div v-else class="project-list-wrapper">
      <ul class="project-list" aria-label="Projects list">
        <li v-for="project in projects" :key="project.id" class="project-item">
          <div class="project-info">
            <div class="title-row">
              <strong class="project-name">{{ project.name }}</strong>
              <StatusPill :tone="statusTone(project.status)">{{ project.status }}</StatusPill>
            </div>
            <p v-if="project.description" class="project-desc">{{ project.description }}</p>
            <div class="project-meta">
              <span>Created {{ new Date(project.createdAt).toLocaleDateString() }}</span>
              <span v-if="project.updatedAt" class="meta-sep">·</span>
              <span v-if="project.updatedAt">Updated {{ new Date(project.updatedAt).toLocaleDateString() }}</span>
            </div>
          </div>
          <div class="project-action">
            <NuxtLink :to="`/app/projects/${project.id}`" class="btn-open">
              Open workspace
            </NuxtLink>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.projects-page {
  max-width: 1080px;
}
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1.75rem;
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
  margin: 0 0 0.25rem;
  font-size: 1.8rem;
  color: #17212b;
}
.muted {
  color: #52606d;
  margin: 0;
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
  white-space: nowrap;
}
.btn-primary:hover {
  background: #134d48;
}
.state-container {
  margin: 2rem 0;
}
.retry-btn {
  margin-top: 0.75rem;
}
.empty-container {
  margin: 2rem 0;
}
.project-list-wrapper {
  margin-top: 1rem;
}
.project-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.project-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.25rem 1.5rem;
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.project-item:hover {
  border-color: #176b65;
  box-shadow: 0 4px 12px rgba(23, 107, 101, 0.06);
}
.project-info {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  flex: 1;
  min-width: 0;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.project-name {
  font-size: 1.1rem;
  color: #17212b;
}
.project-desc {
  color: #52606d;
  font-size: 0.9rem;
  margin: 0;
  line-height: 1.4;
}
.project-meta {
  font-size: 0.8rem;
  color: #68777c;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.meta-sep {
  color: #b9cdca;
}
.project-action {
  flex-shrink: 0;
}
.btn-open {
  display: inline-block;
  background: #f0f7f6;
  border: 1px solid #b9cdca;
  color: #176b65;
  padding: 0.5rem 0.85rem;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 700;
  font-size: 0.85rem;
  transition: all 0.15s ease;
}
.btn-open:hover {
  background: #176b65;
  border-color: #176b65;
  color: #fff;
}
@media (max-width: 680px) {
  .header {
    flex-direction: column;
  }
  .project-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }
  .btn-open {
    width: 100%;
    text-align: center;
    box-sizing: border-box;
  }
}
</style>
