<script setup lang="ts">
import type { Project, ApiError } from "@icooro/shared";

definePageMeta({ layout: "app" });

const api = useApi();
const submitting = ref(false);
const error = ref("");
const form = reactive({ name: "", description: "", status: "draft" });

async function onSubmit() {
  submitting.value = true;
  error.value = "";
  try {
    const created = await api.post<Project>("/projects", {
      name: form.name,
      description: form.description || null,
      status: form.status,
    });
    await navigateTo(`/app/projects/${created.id}`);
  } catch (err: unknown) {
    const apiErr = err as ApiError | null;
    error.value = apiErr?.message ?? (err instanceof Error ? err.message : "Unable to create project.");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section>
    <NuxtLink to="/app/projects" class="back">← Projects</NuxtLink>
    <h1>Create a project</h1>
    <p class="muted">Set up a new storytelling workspace.</p>
    <form class="form" @submit.prevent="onSubmit">
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
        <input v-model="form.status" required maxlength="50" placeholder="draft" />
      </label>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button type="submit" :disabled="submitting">
        {{ submitting ? "Creating…" : "Create project" }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.back {
  color: #176b65;
  text-decoration: none;
  font-weight: 700;
}
h1 {
  margin: 1rem 0 0.25rem;
}
.muted {
  color: #52606d;
  margin: 0 0 1.5rem;
}
.form {
  display: grid;
  gap: 1rem;
  max-width: 640px;
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  padding: 1.5rem;
}
label {
  display: grid;
  gap: 0.4rem;
  font-weight: 600;
}
input,
textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #b9cdca;
  border-radius: 4px;
  padding: 0.6rem;
  font: inherit;
  background: #fff;
}
button {
  border: 0;
  border-radius: 4px;
  background: #176b65;
  color: #fff;
  padding: 0.7rem 1rem;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  width: fit-content;
}
button:disabled {
  opacity: 0.6;
  cursor: wait;
}
.error {
  color: #b42318;
  margin: 0;
}
</style>
