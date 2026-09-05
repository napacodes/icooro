<script setup lang="ts">
type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type ProjectResponse = { data: Project };

const config = useRuntimeConfig();
const route = useRoute();
const router = useRouter();
const project = ref<Project | null>(null);
const loading = ref(true);
const saving = ref(false);
const deleting = ref(false);
const error = ref("");
const formError = ref("");
const form = reactive({ name: "", description: "", status: "" });
const futureModules = ["Episodes", "Script", "Characters", "Locations", "Props", "Scenes", "Shots", "Versions"];

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

async function loadProject() {
  loading.value = true;
  error.value = "";
  try {
    const response = await $fetch<ProjectResponse>(
      `${config.public.apiBase}/api/v1/projects/${route.params.id}`,
    );
    project.value = response.data;
    form.name = response.data.name;
    form.description = response.data.description ?? "";
    form.status = response.data.status;
  } catch (cause) {
    error.value = messageFromError(cause, "Unable to load this project.");
  } finally {
    loading.value = false;
  }
}

async function saveProject() {
  saving.value = true;
  formError.value = "";
  try {
    const response = await $fetch<ProjectResponse>(
      `${config.public.apiBase}/api/v1/projects/${route.params.id}`,
      {
        method: "PATCH",
        body: {
          name: form.name,
          description: form.description || null,
          status: form.status,
        },
      },
    );
    project.value = response.data;
    form.name = response.data.name;
    form.description = response.data.description ?? "";
    form.status = response.data.status;
  } catch (cause) {
    formError.value = messageFromError(cause, "Unable to update this project.");
  } finally {
    saving.value = false;
  }
}

async function deleteProject() {
  if (!window.confirm("Delete this project and its related story data?")) return;
  deleting.value = true;
  formError.value = "";
  try {
    await $fetch(`${config.public.apiBase}/api/v1/projects/${route.params.id}`, {
      method: "DELETE",
    });
    await router.push("/");
  } catch (cause) {
    formError.value = messageFromError(cause, "Unable to delete this project.");
    deleting.value = false;
  }
}

onMounted(loadProject);
</script>

<template>
  <main class="page">
    <NuxtLink to="/" class="back">← Back to projects</NuxtLink>
    <p v-if="loading" class="muted" role="status">Loading workspace…</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>
    <template v-else-if="project">
      <header class="header">
        <p class="eyebrow">Project workspace</p>
        <h1>{{ project.name }}</h1>
        <p class="muted">{{ project.description || "No description provided." }}</p>
      </header>

      <section class="workspace-grid">
        <div class="panel">
          <h2>Project details</h2>
          <form class="form" @submit.prevent="saveProject">
            <label>
              Name
              <input v-model="form.name" required maxlength="255" />
            </label>
            <label>
              Description
              <textarea v-model="form.description" rows="4" />
            </label>
            <label>
              Status
              <input v-model="form.status" required maxlength="50" />
            </label>
            <p v-if="formError" class="error" role="alert">{{ formError }}</p>
            <div class="actions">
              <button type="submit" :disabled="saving || deleting">
                {{ saving ? "Saving…" : "Save changes" }}
              </button>
              <button type="button" class="danger" :disabled="saving || deleting" @click="deleteProject">
                {{ deleting ? "Deleting…" : "Delete project" }}
              </button>
            </div>
          </form>
        </div>

        <div class="panel">
          <h2>Story workspace</h2>
          <p class="muted">Future modules will be added here as the production workflow grows.</p>
          <nav class="module-list" aria-label="Future story modules">
            <span v-for="module in futureModules" :key="module" class="module">{{ module }} <small>Coming later</small></span>
          </nav>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.page {
  min-height: 100vh;
  box-sizing: border-box;
  max-width: 1100px;
  margin: 0 auto;
  padding: 2.5rem 1.25rem;
  font-family: system-ui, sans-serif;
  color: #17212b;
}

.back {
  color: #304fd8;
  text-decoration: none;
}

.header {
  margin: 2rem 0;
}

.eyebrow {
  margin: 0 0 0.35rem;
  color: #4c6fff;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1, h2, p {
  margin: 0;
}

h1 {
  font-size: 2.5rem;
}

h2 {
  margin-bottom: 1rem;
  font-size: 1.25rem;
}

.muted {
  color: #637181;
}

.error {
  color: #b42318;
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
}

.panel {
  border: 1px solid #dbe2ea;
  border-radius: 0.75rem;
  padding: 1.25rem;
}

.form {
  display: grid;
  gap: 1rem;
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

button {
  border: 0;
  border-radius: 0.4rem;
  padding: 0.65rem 0.9rem;
  background: #304fd8;
  color: #fff;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}

button:disabled {
  cursor: wait;
  opacity: 0.65;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.danger {
  background: #b42318;
}

.module-list {
  display: grid;
  gap: 0.5rem;
  margin-top: 1.25rem;
}

.module {
  display: flex;
  justify-content: space-between;
  border-radius: 0.4rem;
  background: #f4f6f8;
  padding: 0.7rem;
}

small {
  color: #637181;
}

@media (max-width: 720px) {
  .workspace-grid {
    grid-template-columns: 1fr;
  }
}
</style>
