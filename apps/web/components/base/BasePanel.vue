<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    elevated?: boolean;
  }>(),
  { elevated: false },
);
</script>

<template>
  <section :class="['base-panel', { 'is-elevated': elevated }]">
    <header v-if="title || $slots.title" class="panel-header">
      <h2 v-if="title">{{ title }}</h2>
      <slot v-else name="title" />
      <div v-if="$slots.actions" class="actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.base-panel {
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  padding: 1.25rem;
  box-shadow: 0 5px 18px rgba(23, 107, 101, 0.04);
}
.is-elevated {
  box-shadow: 0 12px 32px rgba(23, 107, 101, 0.08);
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.panel-header h2 {
  margin: 0;
  font-size: 1.05rem;
}
.actions {
  display: flex;
  gap: 0.5rem;
}
</style>
