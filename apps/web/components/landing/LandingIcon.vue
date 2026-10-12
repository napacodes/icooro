<script setup lang="ts">
/**
 * Inline icon set for the landing page.
 *
 * Icons are a presentation concern: content references them by key
 * (`LandingIconKey`) and this component owns the drawing. Decorative by
 * default — callers place the visible text.
 */
import { computed } from "vue";
import type { LandingIconKey } from "~/landing/types";

const props = defineProps<{ name: LandingIconKey }>();

const PATHS: Record<LandingIconKey, string[]> = {
  story: [
    "M12 6.5C10.8 5.1 9 4.3 6.5 4.3H3v13h3.5c2.5 0 4.3.8 5.5 2.2",
    "M12 6.5c1.2-1.4 3-2.2 5.5-2.2H21v13h-3.5c-2.5 0-4.3.8-5.5 2.2",
    "M12 6.5v12.9",
  ],
  script: [
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M9 13h6",
    "M9 17h4",
  ],
  scenes: [
    "M4 4h7v7H4z",
    "M13 4h7v7h-7z",
    "M4 13h7v7H4z",
    "M13 13h7v7h-7z",
  ],
  shots: ["M8 3v18", "M16 3v18", "M3 8h18", "M3 16h18"],
  generation: [
    "M12 3l1.9 4.9L18.8 9.8l-4.9 1.9L12 16.6l-1.9-4.9L5.2 9.8l4.9-1.9z",
    "M18.4 15.4l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z",
  ],
  tracking: ["M3 12h4l2.6-6.5L13.6 18l2.4-6h5"],
  planning: [
    "M12 3l8.5 4.5L12 12 3.5 7.5z",
    "M3.5 12.3L12 16.8l8.5-4.5",
    "M3.5 16.6L12 21.1l8.5-4.5",
  ],
  ai: [
    "M7.5 7.5h9v9h-9z",
    "M10 3.5v4",
    "M14 3.5v4",
    "M10 16.5v4",
    "M14 16.5v4",
    "M3.5 10h4",
    "M3.5 14h4",
    "M16.5 10h4",
    "M16.5 14h4",
  ],
  execution: [
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    "M8.3 12.3l2.6 2.6 4.8-5.4",
  ],
  projects: [
    "M3 7a2 2 0 0 1 2-2h3.8l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  ],
};

const iconPaths = computed(() => PATHS[props.name] ?? []);
</script>

<template>
  <svg
    class="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in iconPaths" :key="index" :d="d" />
  </svg>
</template>

<style scoped>
.icon {
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
}
</style>
