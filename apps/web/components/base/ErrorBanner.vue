<script setup lang="ts">
withDefaults(
  defineProps<{
    message: string;
    tone?: "error" | "warning" | "info";
  }>(),
  { tone: "error" },
);
</script>

<template>
  <p :class="['error-banner', `is-${tone}`]" role="alert">
    {{ message }}
  </p>
</template>

<style scoped>
.error-banner {
  margin: 0;
  padding: 0.6rem 0.85rem;
  border-radius: 4px;
  font-weight: 600;
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
