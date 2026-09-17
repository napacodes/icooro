<script setup lang="ts">
import { APP_NAME, type Project, type ApiError } from "@icooro/shared";

definePageMeta({ layout: "app" });
defineOptions({ name: "CreateProjectPage" });

const api = useApi();
const submitting = ref(false);
const error = ref("");
const nameError = ref("");

const form = reactive({
  name: "",
  description: "",
  status: "draft",
});

const statusOptions = [
  { value: "draft", label: "Draft — Initial planning" },
  { value: "in_progress", label: "In Progress — Active story development" },
  { value: "active", label: "Active — Ready for production" },
];

function validate(): boolean {
  nameError.value = "";
  if (!form.name.trim()) {
    nameError.value = "Project name is required.";
    return false;
  }
  if (form.name.trim().length > 255) {
    nameError.value = "Project name cannot exceed 255 characters.";
    return false;
  }
  return true;
}

async function onSubmit() {
  if (submitting.value) return;
  if (!validate()) return;

  submitting.value = true;
  error.value = "";
  try {
    const created = await api.post<Project>("/projects", {
      name: form.name.trim(),
      description: form.description.trim() ? form.description.trim() : null,
      status: form.status,
    });
    await navigateTo(`/app/projects/${created.id}`);
  } catch (err: unknown) {
    const apiErr = err as ApiError | null;
    error.value =
      apiErr?.message ??
      (err instanceof Error ? err.message : "Unable to create project. Please check your input and try again.");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="create-project-page">
    <div class="breadcrumb">
      <NuxtLink to="/app/projects" class="back-link">← Back to projects</NuxtLink>
    </div>

    <header class="page-header">
      <p class="eyebrow">{{ APP_NAME }} Studio</p>
      <h1>Create a new project</h1>
      <p class="muted">Set up a production workspace for your story, characters, and media assets.</p>
    </header>

    <div v-if="error" class="error-wrap">
      <ErrorBanner :message="error" />
    </div>

    <form class="project-form" novalidate @submit.prevent="onSubmit">
      <div class="field-group">
        <label for="project-name" class="field-label">
          Project name <span class="required" aria-hidden="true">*</span>
        </label>
        <BaseInput
          id="project-name"
          v-model="form.name"
          placeholder="e.g., Return to Neon City"
          :maxlength="255"
          :disabled="submitting"
          required
        />
        <span v-if="nameError" class="field-error" role="alert">{{ nameError }}</span>
        <span v-else class="field-hint">A distinct title for this creative production.</span>
      </div>

      <div class="field-group">
        <label for="project-description" class="field-label">
          Description <span class="optional">(optional)</span>
        </label>
        <BaseTextarea
          id="project-description"
          v-model="form.description"
          placeholder="Brief premise, logline, or artistic direction…"
          :rows="3"
          :disabled="submitting"
        />
        <span class="field-hint">Helps team members and AI collaborators understand the premise.</span>
      </div>

      <div class="field-group">
        <label for="project-status" class="field-label">Initial status</label>
        <BaseSelect
          id="project-status"
          v-model="form.status"
          :options="statusOptions"
          :disabled="submitting"
        />
        <span class="field-hint">You can change project status at any time during production.</span>
      </div>

      <div class="form-actions">
        <BaseButton
          type="submit"
          variant="primary"
          :loading="submitting"
          :disabled="submitting"
        >
          Create project
        </BaseButton>
        <NuxtLink to="/app/projects" class="cancel-link">Cancel</NuxtLink>
      </div>
    </form>
  </section>
</template>

<style scoped>
.create-project-page {
  max-width: 680px;
}
.breadcrumb {
  margin-bottom: 1rem;
}
.back-link {
  color: #176b65;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9rem;
}
.back-link:hover {
  text-decoration: underline;
}
.page-header {
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
  margin: 0 0 0.35rem;
  font-size: 1.8rem;
  color: #17212b;
}
.muted {
  color: #52606d;
  margin: 0;
  font-size: 1rem;
}
.error-wrap {
  margin-bottom: 1.5rem;
}
.project-form {
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  box-shadow: 0 4px 16px rgba(23, 63, 59, 0.04);
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.field-label {
  font-weight: 700;
  color: #17212b;
  font-size: 0.95rem;
}
.required {
  color: #b42318;
}
.optional {
  font-weight: 400;
  color: #68777c;
  font-size: 0.85rem;
}
.field-hint {
  font-size: 0.8rem;
  color: #68777c;
}
.field-error {
  font-size: 0.85rem;
  color: #b42318;
  font-weight: 600;
}
.form-actions {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-top: 0.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #eef1f5;
}
.cancel-link {
  color: #52606d;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9rem;
}
.cancel-link:hover {
  color: #17212b;
  text-decoration: underline;
}
</style>
