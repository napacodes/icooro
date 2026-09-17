<template>
  <div class="layout-app">
    <header class="topbar">
      <NuxtLink to="/app" class="brand">{{ APP_NAME }}</NuxtLink>
      <nav class="topnav">
        <NuxtLink to="/app">Dashboard</NuxtLink>
        <NuxtLink to="/app/projects">Projects</NuxtLink>
        <NuxtLink to="/app/projects/new">New</NuxtLink>
      </nav>
      <div class="user-menu">
        <span v-if="auth.user.value" class="who">{{ auth.user.value.name }}</span>
        <button class="link" type="button" @click="onLogout">Sign out</button>
      </div>
    </header>
    <div class="shell">
      <aside class="sidebar" aria-label="Application navigation">
        <NuxtLink to="/app">Dashboard</NuxtLink>
        <NuxtLink to="/app/projects">Projects</NuxtLink>
        <NuxtLink to="/app/projects/new">Create project</NuxtLink>
        <span class="section-label">Production</span>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Story</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Episodes</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Scenes</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Shots</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Assets</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Generations</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Timeline</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Export</NuxtLink>
        <NuxtLink to="/app/projects" aria-disabled="true" class="placeholder">Settings</NuxtLink>
      </aside>
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { APP_NAME } from "@icooro/shared";
const auth = useAuth();
async function onLogout() {
  await auth.logout();
  await navigateTo("/login");
}
</script>

<style scoped>
.layout-app {
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
  padding: 0.75rem 1.5rem;
  background: #176b65;
  color: #fff;
  border-bottom: 1px solid #0e4e4a;
}
.brand {
  color: #fff;
  text-decoration: none;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.topnav {
  display: flex;
  gap: 1.25rem;
}
.topnav a {
  color: #d5efed;
  text-decoration: none;
  font-weight: 600;
}
.topnav a:hover,
.topnav a.router-link-active {
  color: #fff;
}
.user-menu {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.who {
  color: #d5efed;
  font-weight: 600;
}
.link {
  background: transparent;
  border: 1px solid #d5efed;
  color: #fff;
  border-radius: 4px;
  padding: 0.35rem 0.7rem;
  cursor: pointer;
  font-weight: 600;
}
.link:hover {
  background: rgba(255, 255, 255, 0.08);
}
.shell {
  display: flex;
  flex: 1;
  min-height: 0;
}
.sidebar {
  width: 240px;
  padding: 1.25rem 1rem;
  background: #fff;
  border-right: 1px solid #d4dfdd;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.sidebar a {
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  text-decoration: none;
  color: #245a56;
  font-weight: 600;
}
.sidebar a:hover {
  background: #e4f1ef;
}
.sidebar a.router-link-active {
  background: #176b65;
  color: #fff;
}
.placeholder {
  opacity: 0.5;
  cursor: not-allowed;
}
.section-label {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #68777c;
}
.content {
  flex: 1;
  padding: 1.5rem 2rem;
  overflow: auto;
}
</style>
