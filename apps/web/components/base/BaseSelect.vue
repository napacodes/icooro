<script setup lang="ts">
interface Option { value: string; label: string }
withDefaults(
  defineProps<{
    modelValue: string;
    options: Option[];
    placeholder?: string;
    disabled?: boolean;
    id?: string;
  }>(),
  { disabled: false },
);
defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <select
    :id="id"
    :value="modelValue"
    :disabled="disabled"
    class="base-select"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-if="placeholder" value="">{{ placeholder }}</option>
    <option v-for="opt in options" :key="opt.value" :value="opt.value">
      {{ opt.label }}
    </option>
  </select>
</template>

<style scoped>
.base-select {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #b7c2cc;
  border-radius: 4px;
  padding: 0.6rem 0.7rem;
  font: inherit;
  background: #fff;
  color: inherit;
}
.base-select:focus {
  outline: 2px solid #176b65;
  outline-offset: 1px;
}
</style>
