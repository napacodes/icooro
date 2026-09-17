<template>
  <div class="layout-admin">
    <header class="topbar">
      <NuxtLink to="/admin" class="brand">
        <span class="brand-name">{{ APP_NAME }}</span>
        <span class="admin-badge" aria-label="Admin control plane">Admin</span>
      </NuxtLink>
      <nav class="topnav">
        <NuxtLink to="/app">Back to app</NuxtLink>
      </nav>
      <div class="user-menu">
        <span v-if="auth.user.value" class="who">{{ auth.user.value.name }}</span>
        <button class="link" type="button" @click="onLogout">Sign out</button>
      </div>
    </header>
    <div class="shell">
      <aside class="sidebar" aria-label="Admin navigation">
        <NuxtLink to="/admin">Overview</NuxtLink>
        <NuxtLink to="/admin/users">Users</NuxtLink>
        <NuxtLink to="/admin/projects">Projects</NuxtLink>
        <span class="section-label">AI</span>
        <NuxtLink to="/admin/providers">Providers</NuxtLink>
        <NuxtLink to="/admin/models">Models</NuxtLink>
        <NuxtLink to="/admin/jobs">Jobs</NuxtLink>
        <span class="section-label">Operations</span>
        <NuxtLink to="/admin/usage">Usage</NuxtLink>
        <NuxtLink to="/admin/quotas">Quotas</NuxtLink>
        <NuxtLink to="/admin/storage">Storage</NuxtLink>
        <span class="section-label">System</span>
        <NuxtLink to="/admin/settings">Settings</NuxtLink>
        <NuxtLink to="/admin/audit">Audit logs</NuxtLink>
        <NuxtLink to="/admin/security">Security</NuxtLink>
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
.layout-admin {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0f1419;
  color: #e6e9ec;
  font-family: system-ui, sans-serif;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  background: #1a2128;
  border-bottom: 1px solid #2a323b;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
}
.brand-name {
  color: #fff;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.admin-badge {
  background: #d35b3e;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  padding: 0.2rem 0.55rem;
  border-radius: 4px;
  letter-spacing: 0.06em;
}
.topnav a {
  color: #cfd6db;
  text-decoration: none;
  font-weight: 600;
}
.user-menu {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.who {
  color: #cfd6db;
  font-weight: 600;
}
.link {
  background: transparent;
  border: 1px solid #2a323b;
  color: #e6e9ec;
  border-radius: 4px;
  padding: 0.35rem 0.7rem;
  cursor: pointer;
  font-weight: 600;
}
.link:hover {
  background: #2a323b;
}
.shell {
  display: flex;
  flex: 1;
  min-height: 0;
}
.sidebar {
  width: 260px;
  padding: 1.25rem 1rem;
  background: #141a20;
  border-right: 1px solid #2a323b;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.sidebar a {
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  text-decoration: none;
  color: #cfd6db;
  font-weight: 600;
}
.sidebar a:hover {
  background: #1f272f;
}
.sidebar a.router-link-active {
  background: #d35b3e;
  color: #fff;
}
.section-label {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6b7682;
}
.content {
  flex: 1;
  padding: 1.5rem 2rem;
  overflow: auto;
}
</style>
