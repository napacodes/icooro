<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: "neutral" | "success" | "warning" | "danger" | "info";
  }>(),
  { tone: "neutral" },
);
</script>

<template>
  <span :class="['status-pill', `is-${tone}`]">
    <slot />
  </span>
</template>

<style scoped>
.status-pill {
  display: inline-block;
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1.2;
  border: 1px solid transparent;
}
.is-neutral {
  background: #eef1f5;
  color: #52606d;
}
.is-success {
  background: #e7f3d9;
  color: #44711e;
}
.is-warning {
  background: #fff3cd;
  color: #8a5a00;
}
.is-danger {
  background: #fde2e1;
  color: #a62e25;
}
.is-info {
  background: #d8e8ff;
  color: #243da8;
}
</style>
