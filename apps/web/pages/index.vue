<script setup lang="ts">
import { APP_NAME } from "@icooro/shared";
</script>

<template>
  <main class="home">
    <h1>{{ APP_NAME }}</h1>
    <p>AI Video Production Platform</p>
    <p>Development environment is running.</p>
  </main>
</template>

<style scoped>
.home {
  min-height: 100vh;
  margin: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 0.5rem;
  font-family: system-ui, sans-serif;
  background: #0f1419;
  color: #e8eef4;
  text-align: center;
}

h1 {
  margin: 0;
  font-size: 2.25rem;
  font-weight: 650;
}

p {
  margin: 0;
  color: #b7c2cc;
}
</style>
