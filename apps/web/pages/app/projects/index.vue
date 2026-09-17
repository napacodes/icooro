<script setup lang="ts">
import type { Project } from "@icooro/shared";

definePageMeta({ layout: "app" });

const api = useApi();
const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref("");

async function load() {
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

onMounted(load);
</script>

<template>
  <section>
    <header class="header">
      <div>
        <h1>Projects</h1>
        <p class="muted">Your storytelling workspaces.</p>
      </div>
      <NuxtLink to="/app/projects/new" class="button">New project</NuxtLink>
    </header>
    <p v-if="loading" class="muted" role="status">Loading projects…</p>
    <p v-else-if="error" role="alert" class="error">{{ error }}</p>
    <div v-else-if="projects.length === 0" class="empty">
      <p>No projects yet.</p>
      <p class="muted">Create your first project to begin planning a story.</p>
      <NuxtLink to="/app/projects/new" class="button">Create a project</NuxtLink>
    </div>
    <ul v-else class="list">
      <li v-for="project in projects" :key="project.id" class="item">
        <div>
          <strong>{{ project.name }}</strong>
          <small v-if="project.description" class="muted">{{ project.description }}</small>
        </div>
        <span class="status">{{ project.status }}</span>
        <NuxtLink :to="`/app/projects/${project.id}`" class="link">Open workspace</NuxtLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
}
h1 {
  margin: 0 0 0.25rem;
}
.muted {
  color: #52606d;
}
.button {
  display: inline-block;
  background: #176b65;
  color: #fff;
  padding: 0.55rem 0.85rem;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 700;
}
.empty {
  background: #fff;
  border: 1px dashed #b9cdca;
  border-radius: 8px;
  padding: 2rem;
  text-align: center;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.item {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 1rem;
  align-items: center;
  padding: 0.85rem 1rem;
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 6px;
}
.item small {
  display: block;
  margin-top: 0.2rem;
}
.status {
  background: #eef1f5;
  color: #52606d;
  border-radius: 999px;
  padding: 0.25rem 0.55rem;
  font-size: 0.85rem;
}
.link {
  color: #243da8;
  text-decoration: none;
  font-weight: 700;
}
.error {
  color: #b42318;
}
@media (max-width: 680px) {
  .item {
    grid-template-columns: 1fr;
  }
}
</style>
