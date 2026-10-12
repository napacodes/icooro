<script setup lang="ts">
/**
 * Dashboard page header (F2).
 *
 * Greets the signed-in user and exposes the single clear primary action of the
 * dashboard: creating a new project. Styled with the F1 semantic tokens so it
 * follows the approved light-by-default, dark-mode-ready visual direction.
 */
import { APP_NAME } from "@icooro/shared";

withDefaults(
  defineProps<{
    /** Signed-in user's display name, or null while the session loads. */
    userName?: string | null;
  }>(),
  { userName: null },
);
</script>

<template>
  <header class="dashboard-header">
    <div class="intro">
      <p class="eyebrow">{{ APP_NAME }} Studio</p>
      <h1>Dashboard</h1>
      <p v-if="userName" class="lede">
        Welcome back, <strong>{{ userName }}</strong
        >. Manage your creative workspaces and production assets.
      </p>
      <p v-else class="lede">Loading workspace…</p>
    </div>

    <div class="actions">
      <NuxtLink to="/app/projects/new" class="btn btn-primary">
        <svg
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        New project
      </NuxtLink>
    </div>
  </header>
</template>

<style scoped>
.dashboard-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.eyebrow {
  margin: 0 0 0.4rem;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-accent);
}

h1 {
  margin: 0 0 0.4rem;
  font-size: clamp(1.6rem, 3vw, 2rem);
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.lede {
  margin: 0;
  max-width: 44rem;
  color: var(--color-text-muted);
  line-height: 1.6;
}

.actions {
  flex: none;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.65rem 1.1rem;
  border-radius: var(--radius-md);
  font-weight: 700;
  font-size: 0.92rem;
  text-decoration: none;
  border: 1px solid transparent;
  transition:
    background-color var(--motion-fast) ease,
    border-color var(--motion-fast) ease,
    color var(--motion-fast) ease;
}

.btn-primary {
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  box-shadow: var(--shadow-sm);
}

.btn-primary:hover {
  background: var(--color-accent-strong);
}

.btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.icon {
  width: 1.05rem;
  height: 1.05rem;
}

@media (max-width: 640px) {
  .dashboard-header {
    flex-direction: column;
  }

  .actions,
  .btn {
    width: 100%;
  }

  .btn {
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .btn {
    transition: none;
  }
}
</style>
