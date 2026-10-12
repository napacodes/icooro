<script setup lang="ts">
/**
 * Project section navigation (F3.1).
 *
 * The single project-level navigation for the workspace shell. Every entry
 * comes from the canonical registry in `~/workspace/sections`, so the labels,
 * order, and destinations cannot drift from the routes that exist.
 *
 * Accessibility:
 * - the `<nav>` is named, so screen-reader users can distinguish it from the
 *   application navigation in the layout;
 * - the current section carries `aria-current="page"` (computed from the route,
 *   not from link-matching CSS), which is what assistive technology announces;
 * - every link has a visible `:focus-visible` ring.
 *
 * On narrow viewports the row keeps a single line and scrolls horizontally
 * instead of wrapping, so the section order stays stable and legible.
 */
import { computed } from "vue";
import {
  WORKSPACE_SECTIONS,
  workspaceSectionForPath,
  workspaceSectionPath,
} from "~/workspace/sections";

const props = defineProps<{ projectId: string }>();

const route = useRoute();

/** Slug of the section the current route belongs to, or `null`. */
const activeSlug = computed(() => workspaceSectionForPath(route.path)?.slug ?? null);
</script>

<template>
  <nav class="workspace-nav" aria-label="Project sections">
    <ul class="workspace-nav-list">
      <li v-for="section in WORKSPACE_SECTIONS" :key="section.slug">
        <NuxtLink
          :to="workspaceSectionPath(props.projectId, section.slug)"
          class="workspace-nav-link"
          :class="{ 'is-active': activeSlug === section.slug }"
          :aria-current="activeSlug === section.slug ? 'page' : undefined"
        >
          {{ section.label }}
        </NuxtLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.workspace-nav {
  margin-bottom: 1.5rem;
  border-bottom: 2px solid #e1ebe9;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.workspace-nav-list {
  display: flex;
  gap: 0.5rem;
  /* Keep every section on one line; the nav scrolls when space runs out. */
  min-width: max-content;
  /* Room for the focus ring so it is never clipped by the scroll container. */
  padding: 3px 0 0;
  margin: 0;
  list-style: none;
}

.workspace-nav-link {
  display: inline-block;
  padding: 0.65rem 1.25rem;
  color: #556968;
  text-decoration: none;
  font-weight: 600;
  white-space: nowrap;
  border-bottom: 3px solid transparent;
  margin-bottom: -2px;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.workspace-nav-link:hover {
  color: #176b65;
}

.workspace-nav-link.is-active {
  color: #176b65;
  border-bottom-color: #176b65;
}

.workspace-nav-link:focus-visible {
  outline: 2px solid #176b65;
  outline-offset: 2px;
  border-radius: 4px 4px 0 0;
}

@media (prefers-reduced-motion: reduce) {
  .workspace-nav-link {
    transition: none;
  }
}
</style>
