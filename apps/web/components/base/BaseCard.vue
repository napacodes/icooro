<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    as?: string;
  }>(),
  { as: "article" },
);
</script>

<template>
  <component :is="as" class="base-card">
    <h3 v-if="title">{{ title }}</h3>
    <slot />
  </component>
</template>

<style scoped>
.base-card {
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  padding: 1rem 1.1rem;
}
h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
</style>
