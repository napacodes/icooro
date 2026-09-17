<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
  }>(),
  {},
);
</script>

<template>
  <div class="empty-state">
    <h3 v-if="title">{{ title }}</h3>
    <p v-if="description" class="muted">{{ description }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty-state {
  border: 1px dashed #b9cdca;
  border-radius: 8px;
  padding: 2rem;
  text-align: center;
  background: #fff;
  color: #52606d;
}
h3 {
  margin: 0 0 0.4rem;
  color: #17212b;
}
.muted {
  margin: 0 0 0.75rem;
}
</style>
