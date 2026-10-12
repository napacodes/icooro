<script setup lang="ts">
/**
 * Project card (F2).
 *
 * Renders a single project from its real API payload — name, status,
 * description and timestamps — plus a link into the existing project
 * workspace route. It owns no data fetching, so it can be reused by any list
 * of projects.
 *
 * Reuses the shared `StatusPill` component and `statusTone` mapping so project
 * status is presented identically across the workspace.
 */
import { computed } from "vue";
import type { Project } from "@icooro/shared";
import { statusTone } from "~/composables/useStatusTone";

const props = defineProps<{
  project: Project;
}>();

const titleId = computed(() => `project-${props.project.id}-title`);
const createdLabel = computed(() => new Date(props.project.createdAt).toLocaleDateString());
const updatedLabel = computed(() => new Date(props.project.updatedAt).toLocaleDateString());
</script>

<template>
  <article class="project-card" :aria-labelledby="titleId">
    <div class="card-head">
      <h3 :id="titleId" class="project-title">{{ project.name }}</h3>
      <StatusPill :tone="statusTone(project.status)">{{ project.status }}</StatusPill>
    </div>

    <p v-if="project.description" class="project-desc">{{ project.description }}</p>
    <p v-else class="project-desc is-placeholder">No description provided.</p>

    <div class="card-foot">
      <span class="dates">
        Created {{ createdLabel }}
        <span class="sep" aria-hidden="true">·</span>
        Updated {{ updatedLabel }}
      </span>
      <NuxtLink :to="`/app/projects/${project.id}`" class="open-link">
        Open workspace <span aria-hidden="true">→</span>
      </NuxtLink>
    </div>
  </article>
</template>

<style scoped>
.project-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 1.25rem 1.35rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition:
    border-color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}

.project-card:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
}

.project-title {
  margin: 0;
  font-size: 1.05rem;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.project-desc {
  margin: 0 0 1.25rem;
  color: var(--color-text-muted);
  font-size: 0.92rem;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.is-placeholder {
  color: var(--color-text-faint);
  font-style: italic;
}

.card-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--color-border);
}

.dates {
  font-size: 0.78rem;
  color: var(--color-text-faint);
}

.sep {
  margin: 0 0.25rem;
}

.open-link {
  flex: none;
  color: var(--color-accent);
  text-decoration: none;
  font-weight: 700;
  font-size: 0.85rem;
}

.open-link:hover {
  text-decoration: underline;
}

.open-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}

@media (prefers-reduced-motion: reduce) {
  .project-card,
  .project-card:hover {
    transition: none;
    transform: none;
  }
}
</style>
