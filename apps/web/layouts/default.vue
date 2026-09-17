<template>
  <div class="layout-public">
    <header class="topbar">
      <NuxtLink to="/" class="brand">{{ APP_NAME }}</NuxtLink>
      <nav class="nav">
        <NuxtLink to="/app">Open app</NuxtLink>
      </nav>
    </header>
    <main class="content">
      <slot />
    </main>
    <footer class="footer">
      <span>&copy; {{ year }} {{ APP_NAME }}</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { APP_NAME } from "@icooro/shared";
const year = new Date().getFullYear();
</script>

<style scoped>
.layout-public {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f4f7f8;
  color: #17212b;
  font-family: system-ui, sans-serif;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 2rem;
  border-bottom: 1px solid #dbe2ea;
  background: #fff;
}
.brand {
  font-weight: 700;
  text-decoration: none;
  color: #4c6fff;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.nav a {
  margin-left: 1.5rem;
  text-decoration: none;
  color: #17212b;
  font-weight: 600;
}
.nav a:hover {
  color: #4c6fff;
}
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.footer {
  padding: 1.5rem 2rem;
  border-top: 1px solid #dbe2ea;
  color: #637181;
  font-size: 0.875rem;
  background: #fff;
}
</style>
