<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    type?: string;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    autocomplete?: string;
    minlength?: number;
    maxlength?: number;
    id?: string;
  }>(),
  { type: "text", required: false, disabled: false },
);
defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <input
    :id="id"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :required="required"
    :disabled="disabled"
    :autocomplete="autocomplete"
    :minlength="minlength"
    :maxlength="maxlength"
    class="base-input"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.base-input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #b7c2cc;
  border-radius: 4px;
  padding: 0.6rem 0.7rem;
  font: inherit;
  background: #fff;
  color: inherit;
}
.base-input:focus {
  outline: 2px solid #176b65;
  outline-offset: 1px;
}
.base-input:disabled {
  background: #f4f7f8;
  color: #637181;
}
</style>
