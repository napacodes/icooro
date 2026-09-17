<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: "button" | "submit" | "reset";
    variant?: "primary" | "secondary" | "danger";
    size?: "sm" | "md";
    disabled?: boolean;
    loading?: boolean;
  }>(),
  { type: "button", variant: "primary", size: "md", disabled: false, loading: false },
);
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="['base-button', `is-${variant}`, `is-${size}`, { 'is-loading': loading }]"
  >
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.base-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 0;
  border-radius: 4px;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  transition: background-color 0.1s ease;
}
.base-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.is-sm {
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
}
.is-md {
  padding: 0.6rem 0.95rem;
}
.is-primary {
  background: #176b65;
  color: #fff;
}
.is-primary:hover:not(:disabled) {
  background: #134d48;
}
.is-secondary {
  background: #eef1ff;
  color: #243da8;
}
.is-secondary:hover:not(:disabled) {
  background: #dee4ff;
}
.is-danger {
  background: #b42318;
  color: #fff;
}
.is-danger:hover:not(:disabled) {
  background: #8c1a12;
}
.spinner {
  width: 0.9em;
  height: 0.9em;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
