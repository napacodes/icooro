<template>
  <div class="redirecting">
    <LoadingState message="Opening workspace…" />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";

const route = useRoute();
const projectId = route.params.id as string;

onMounted(async () => {
  if (projectId) {
    await navigateTo(`/app/projects/${projectId}/story`, { replace: true });
  }
});
</script>

<style scoped>
.redirecting {
  padding: 3rem 0;
}
</style>
