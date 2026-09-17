<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string;
  }>(),
  { label: "Loading…" },
);
</script>

<template>
  <p class="loading-state" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true" />
    {{ label }}
  </p>
</template>

<style scoped>
.loading-state {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: #52606d;
}
.spinner {
  width: 1em;
  height: 1em;
  border: 2px solid #b7c2cc;
  border-top-color: #176b65;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
