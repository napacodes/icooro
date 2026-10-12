<script setup lang="ts">
/**
 * Dashboard summary strip (F2).
 *
 * Reports only what the API actually returns today: the total number of
 * projects the signed-in user owns. No derived or illustrative statistics are
 * shown, so the dashboard never fabricates activity.
 */
defineProps<{
  /** Number of projects returned by `GET /projects`. */
  projectCount: number;
}>();
</script>

<template>
  <section class="summary" aria-label="Workspace summary">
    <div class="stat-card">
      <p class="stat-label">Total Projects</p>
      <p class="stat-value">{{ projectCount }}</p>
      <NuxtLink to="/app/projects" class="stat-link">
        View all projects <span aria-hidden="true">→</span>
      </NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.summary {
  margin-bottom: 2rem;
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  max-width: 22rem;
  padding: 1.25rem 1.4rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.stat-label {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}

.stat-value {
  margin: 0.15rem 0 0.4rem;
  font-size: 2.1rem;
  font-weight: 800;
  line-height: 1;
  color: var(--color-text);
}

.stat-link {
  color: var(--color-accent);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9rem;
}

.stat-link:hover {
  text-decoration: underline;
}

.stat-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}
</style>
