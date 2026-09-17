<template>
  <div class="project-workspace">
    <nav class="breadcrumb-nav" aria-label="Breadcrumbs">
      <NuxtLink to="/app/projects" class="back-link">← Projects</NuxtLink>
    </nav>

    <LoadingState v-if="loading" message="Loading project workspace…" />
    <ErrorBanner
      v-else-if="error"
      :message="error"
      retry-label="Retry"
      @retry="loadProject"
    />

    <template v-else-if="project">
      <header class="workspace-header">
        <div class="header-main">
          <div class="title-row">
            <h1 class="project-title">{{ project.name }}</h1>
            <StatusPill :tone="statusTone(project.status)">{{ project.status }}</StatusPill>
          </div>
          <p class="project-description">
            {{ project.description || "Production workspace for story, episodes, scenes, shots, assets, and generations." }}
          </p>
        </div>
        <div class="header-actions">
          <BaseButton
            size="sm"
            variant="secondary"
            @click="showProjectSettings = !showProjectSettings"
          >
            {{ showProjectSettings ? "Close Settings" : "Project Settings" }}
          </BaseButton>
        </div>
      </header>

      <!-- Collapsible Project Settings Panel -->
      <BasePanel
        v-if="showProjectSettings"
        title="Project Settings"
        description="Update project name, description, or status."
        class="settings-panel"
      >
        <form class="settings-form" @submit.prevent="onUpdateProject">
          <BaseInput
            v-model="form.name"
            label="Project Name"
            required
            :maxlength="255"
          />
          <BaseTextarea
            v-model="form.description"
            label="Description"
            :rows="2"
            :maxlength="1000"
          />
          <BaseSelect
            v-model="form.status"
            label="Status"
            :options="statusOptions"
          />
          <div class="settings-buttons">
            <BaseButton
              type="submit"
              variant="primary"
              :loading="saving"
            >
              Save Changes
            </BaseButton>
            <BaseButton
              type="button"
              variant="danger"
              :disabled="saving"
              @click="showDeleteConfirm = true"
            >
              Delete Project
            </BaseButton>
          </div>
        </form>
      </BasePanel>

      <!-- Navigation Tabs for the 6 Workspace Sections -->
      <nav class="workspace-tabs" aria-label="Workspace sections">
        <NuxtLink
          v-for="section in sections"
          :key="section.slug"
          :to="`/app/projects/${projectId}/${section.slug}`"
          class="tab-link"
          active-class="active"
        >
          {{ section.label }}
        </NuxtLink>
      </nav>

      <!-- Section Content Rendered by Child Route -->
      <section class="workspace-content">
        <NuxtPage />
      </section>
    </template>

    <ConfirmDialog
      :open="showDeleteConfirm"
      title="Delete Project"
      message="Are you sure you want to delete this project and all of its production data? This action cannot be undone."
      confirm-label="Delete Project"
      destructive
      @confirm="onDeleteProject"
      @cancel="showDeleteConfirm = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from "vue";

definePageMeta({ layout: "app" });

const {
  project,
  loading,
  error,
  saving,
  projectId,
  loadProject,
  updateProject,
  deleteProject,
} = useWorkspaceProject();

const showProjectSettings = ref(false);
const showDeleteConfirm = ref(false);

const form = reactive({
  name: "",
  description: "",
  status: "draft",
});

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  switch ((status || "").toLowerCase()) {
    case "active":
    case "completed":
    case "ready":
    case "approved":
      return "success";
    case "in_progress":
    case "processing":
    case "submitted":
    case "downloading":
      return "info";
    case "draft":
    case "pending":
    case "queued":
      return "warning";
    case "archived":
    case "failed":
    case "rejected":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

const statusOptions = [
  { label: "Draft", value: "draft" },
  { label: "In Progress", value: "in_progress" },
  { label: "Completed", value: "completed" },
  { label: "Archived", value: "archived" },
];

const sections = [
  { slug: "story", label: "Story" },
  { slug: "episodes", label: "Episodes" },
  { slug: "scenes", label: "Scenes" },
  { slug: "shots", label: "Shots" },
  { slug: "assets", label: "Assets" },
  { slug: "generations", label: "Generations" },
];

watch(
  project,
  (p) => {
    if (p) {
      form.name = p.name;
      form.description = p.description ?? "";
      form.status = p.status;
    }
  },
  { immediate: true },
);

onMounted(loadProject);

async function onUpdateProject() {
  try {
    await updateProject({
      name: form.name.trim(),
      description: form.description.trim() || null,
      status: form.status,
    });
    showProjectSettings.value = false;
  } catch (err) {
    console.error("Failed to update project", err);
  }
}

async function onDeleteProject() {
  try {
    await deleteProject();
  } catch (err) {
    console.error("Failed to delete project", err);
  }
}
</script>

<style scoped>
.project-workspace {
  max-width: 1300px;
  margin: 0 auto;
  padding: 0.5rem 0 3rem;
}

.breadcrumb-nav {
  margin-bottom: 1rem;
}

.back-link {
  color: #176b65;
  font-weight: 600;
  text-decoration: none;
  font-size: 0.95rem;
}

.back-link:hover {
  text-decoration: underline;
}

.workspace-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid #d4dfdd;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.project-title {
  margin: 0;
  font-size: 1.85rem;
  font-weight: 750;
  color: #17212b;
}

.project-description {
  margin: 0.35rem 0 0;
  color: #556968;
  font-size: 0.95rem;
  max-width: 750px;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

.settings-panel {
  margin-bottom: 1.5rem;
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.settings-buttons {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.workspace-tabs {
  display: flex;
  gap: 0.5rem;
  border-bottom: 2px solid #e1ebe9;
  margin-bottom: 1.5rem;
  overflow-x: auto;
}

.tab-link {
  padding: 0.65rem 1.25rem;
  color: #556968;
  text-decoration: none;
  font-weight: 600;
  border-bottom: 3px solid transparent;
  margin-bottom: -2px;
  transition: all 0.15s ease;
}

.tab-link:hover {
  color: #176b65;
}

.tab-link.active {
  color: #176b65;
  border-bottom-color: #176b65;
}

.workspace-content {
  min-height: 400px;
}
</style>
