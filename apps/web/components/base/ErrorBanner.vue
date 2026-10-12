<script setup lang="ts">
/**
 * Inline error / warning / info banner.
 *
 * Message-only usage is unchanged (`<ErrorBanner :message="error" />`).
 * Passing `retryLabel` additionally renders a retry action that emits `retry`,
 * so views can re-run their own load function instead of leaving the user with
 * a dead end.
 */
withDefaults(
  defineProps<{
    message: string;
    tone?: "error" | "warning" | "info";
    /** Accessible label for the retry action; no action is rendered without it. */
    retryLabel?: string;
  }>(),
  { tone: "error" },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <p :class="['error-banner', `is-${tone}`]" role="alert">
    <span class="error-message">{{ message }}</span>
    <button
      v-if="retryLabel"
      type="button"
      class="retry-button"
      @click="$emit('retry')"
    >
      {{ retryLabel }}
    </button>
  </p>
</template>

<style scoped>
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0;
  padding: 0.6rem 0.85rem;
  border-radius: 4px;
  font-weight: 600;
}
.error-message {
  min-width: 0;
  overflow-wrap: anywhere;
}
.retry-button {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 700;
  padding: 0.3rem 0.7rem;
  border-radius: 4px;
  cursor: pointer;
}
.retry-button:hover {
  background: rgba(0, 0, 0, 0.07);
}
.retry-button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.is-error {
  background: #fde2e1;
  color: #a62e25;
  border: 1px solid #f3b8b3;
}
.is-warning {
  background: #fff3cd;
  color: #8a5a00;
  border: 1px solid #f0d57f;
}
.is-info {
  background: #d8e8ff;
  color: #243da8;
  border: 1px solid #a8c1ff;
}
</style>
