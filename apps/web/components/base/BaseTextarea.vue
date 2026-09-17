<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    rows?: number;
    required?: boolean;
    disabled?: boolean;
    maxlength?: number;
    id?: string;
  }>(),
  { rows: 3, required: false, disabled: false },
);
defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <textarea
    :id="id"
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :required="required"
    :disabled="disabled"
    :maxlength="maxlength"
    class="base-textarea"
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>

<style scoped>
.base-textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #b7c2cc;
  border-radius: 4px;
  padding: 0.6rem 0.7rem;
  font: inherit;
  resize: vertical;
  background: #fff;
  color: inherit;
}
.base-textarea:focus {
  outline: 2px solid #176b65;
  outline-offset: 1px;
}
</style>
