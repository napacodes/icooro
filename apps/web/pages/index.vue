<script setup lang="ts">
import { APP_NAME } from "@icooro/shared";

type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type ProjectResponse = { data: Project };
type ProjectListResponse = { data: Project[] };

const config = useRuntimeConfig();
const projects = ref<Project[]>([]);
const loading = ref(true);
const submitting = ref(false);
const error = ref("");
const formError = ref("");
const form = reactive({ name: "", description: "", status: "draft" });

function messageFromError(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "data" in value) {
    const data = value.data;
    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      data.error &&
      typeof data.error === "object" &&
      "message" in data.error &&
      typeof data.error.message === "string"
    ) {
      return data.error.message;
    }
  }
  return fallback;
}

async function loadProjects() {
  loading.value = true;
  error.value = "";
  try {
    const response = await $fetch<ProjectListResponse>(
      `${config.public.apiBase}/api/v1/projects`,
    );
    projects.value = response.data;
  } catch (cause) {
    error.value = messageFromError(cause, "Unable to load projects.");
  } finally {
    loading.value = false;
  }
}

async function createProject() {
  submitting.value = true;
  formError.value = "";
  try {
    const response = await $fetch<ProjectResponse>(
      `${config.public.apiBase}/api/v1/projects`,
      {
        method: "POST",
        body: {
          name: form.name,
          description: form.description || null,
          status: form.status,
        },
      },
    );
    projects.value = [response.data, ...projects.value];
    form.name = "";
    form.description = "";
    form.status = "draft";
  } catch (cause) {
    formError.value = messageFromError(cause, "Unable to create project.");
  } finally {
    submitting.value = false;
  }
}

onMounted(loadProjects);
</script>

<template>
  <main class="page">
    <header class="header">
      <div>
        <p class="eyebrow">{{ APP_NAME }}</p>
        <h1>Projects</h1>
        <p class="muted">Your storytelling workspaces.</p>
      </div>
    </header>

    <section class="panel">
      <h2>New project</h2>
      <form class="form" @submit.prevent="createProject">
        <label>
          Name
          <input v-model="form.name" required maxlength="255" placeholder="Project name" />
        </label>
        <label>
          Description
          <textarea v-model="form.description" rows="3" placeholder="Optional description" />
        </label>
        <label>
          Status
          <input v-model="form.status" required maxlength="50" />
        </label>
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <button type="submit" :disabled="submitting">
          {{ submitting ? "Creating…" : "Create project" }}
        </button>
      </form>
    </section>

    <section aria-labelledby="projects-heading">
      <h2 id="projects-heading">Your projects</h2>
      <p v-if="loading" class="muted" role="status">Loading projects…</p>
      <p v-else-if="error" class="error" role="alert">{{ error }}</p>
      <div v-else-if="projects.length === 0" class="empty">
        <p>No projects yet.</p>
        <p class="muted">Create your first project to begin planning a story.</p>
      </div>
      <div v-else class="project-list">
        <article v-for="project in projects" :key="project.id" class="project-card">
          <div>
            <h3>{{ project.name }}</h3>
            <p v-if="project.description" class="muted">{{ project.description }}</p>
          </div>
          <span class="status">{{ project.status }}</span>
          <NuxtLink class="button secondary" :to="`/projects/${project.id}`">Open workspace</NuxtLink>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page {
  min-height: 100vh;
  box-sizing: border-box;
  max-width: 980px;
  margin: 0 auto;
  padding: 3rem 1.25rem;
  font-family: system-ui, sans-serif;
  color: #17212b;
}

.header {
  margin-bottom: 2rem;
}

.eyebrow, h1, h2, h3, p {
  margin: 0;
}

.eyebrow {
  color: #4c6fff;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin-top: 0.35rem;
  font-size: 2.5rem;
}

h2 {
  margin-bottom: 1rem;
  font-size: 1.25rem;
}

.muted {
  color: #637181;
}

.panel, .empty, .project-card {
  border: 1px solid #dbe2ea;
  border-radius: 0.75rem;
  background: #fff;
}

.panel {
  margin-bottom: 2.5rem;
  padding: 1.25rem;
}

.form {
  display: grid;
  gap: 1rem;
  max-width: 640px;
}

label {
  display: grid;
  gap: 0.4rem;
  font-weight: 600;
}

input, textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #b7c2cc;
  border-radius: 0.4rem;
  padding: 0.65rem;
  font: inherit;
}

button, .button {
  display: inline-block;
  width: fit-content;
  border: 0;
  border-radius: 0.4rem;
  padding: 0.65rem 0.9rem;
  background: #304fd8;
  color: #fff;
  font: inherit;
  font-weight: 650;
  text-decoration: none;
  cursor: pointer;
}

button:disabled {
  cursor: wait;
  opacity: 0.65;
}

.secondary {
  background: #eef1ff;
  color: #243da8;
}

.error {
  color: #b42318;
}

.empty {
  padding: 2rem;
}

.project-list {
  display: grid;
  gap: 0.75rem;
}

.project-card {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
}

.project-card h3 {
  margin-bottom: 0.35rem;
}

.status {
  border-radius: 999px;
  background: #eef1f5;
  padding: 0.3rem 0.6rem;
  color: #52606d;
  font-size: 0.85rem;
}

@media (max-width: 680px) {
  .project-card {
    grid-template-columns: 1fr;
  }
}
</style>
