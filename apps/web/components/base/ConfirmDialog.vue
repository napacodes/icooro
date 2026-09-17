<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }>(),
  { confirmLabel: "Confirm", cancelLabel: "Cancel", destructive: false },
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();

function onKey(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === "Escape") emit("cancel");
  if (e.key === "Enter") emit("confirm");
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div v-if="open" class="confirm-overlay" role="dialog" aria-modal="true">
    <div class="confirm-card">
      <h2>{{ title }}</h2>
      <p>{{ message }}</p>
      <div class="actions">
        <BaseButton variant="secondary" @click="emit('cancel')">{{ cancelLabel }}</BaseButton>
        <BaseButton :variant="destructive ? 'danger' : 'primary'" @click="emit('confirm')">
          {{ confirmLabel }}
        </BaseButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 20, 25, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1.5rem;
}
.confirm-card {
  background: #fff;
  border-radius: 8px;
  padding: 1.5rem;
  max-width: 440px;
  width: 100%;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.2);
}
.confirm-card h2 {
  margin: 0 0 0.5rem;
  font-size: 1.15rem;
}
.confirm-card p {
  margin: 0 0 1rem;
  color: #52606d;
}
.actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}
</style>
