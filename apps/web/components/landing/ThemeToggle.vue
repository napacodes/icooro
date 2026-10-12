<script setup lang="ts">
/**
 * Theme switch for the public site.
 *
 * One button toggles light/dark and pins the choice (persisted by
 * `useTheme`). The accessible name combines the content-provided label with
 * the current state, so screen-reader users always know what a press will do.
 */
import { computed } from "vue";
import { useTheme } from "~/composables/useTheme";

const props = defineProps<{ label: string }>();

const { resolved, toggle } = useTheme();

const isDark = computed(() => resolved.value === "dark");
const stateText = computed(() => (isDark.value ? "Dark theme active" : "Light theme active"));
const ariaLabel = computed(() => `${props.label}: ${stateText.value}`);
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :aria-label="ariaLabel"
    :title="ariaLabel"
    :aria-pressed="isDark"
    @click="toggle"
  >
    <svg
      v-if="isDark"
      class="glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5 8.5 8.5 0 1 0 20.5 14.6z" />
    </svg>
    <svg
      v-else
      class="glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path
        d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"
      />
    </svg>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--motion-fast) ease,
    border-color var(--motion-fast) ease,
    background-color var(--motion-fast) ease;
}

.theme-toggle:hover {
  color: var(--color-accent);
  border-color: var(--color-border-strong);
}

.theme-toggle:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.glyph {
  width: 1.15rem;
  height: 1.15rem;
}
</style>
