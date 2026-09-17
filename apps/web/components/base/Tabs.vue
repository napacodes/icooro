<script setup lang="ts">
defineProps<{
  modelValue: string;
  tabs: { value: string; label: string }[];
}>();
defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <nav class="base-tabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.value"
      :class="['tab', { 'is-active': modelValue === tab.value }]"
      role="tab"
      :aria-selected="modelValue === tab.value"
      type="button"
      @click="$emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
    </button>
  </nav>
</template>

<style scoped>
.base-tabs {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  border-bottom: 1px solid #d4dfdd;
  margin-bottom: 1rem;
}
.tab {
  border: 1px solid #b9cdca;
  background: #fff;
  color: #245a56;
  border-radius: 4px 4px 0 0;
  padding: 0.5rem 0.85rem;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.tab.is-active {
  background: #176b65;
  color: #fff;
  border-color: #176b65;
}
</style>
