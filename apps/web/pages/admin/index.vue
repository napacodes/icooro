<script setup lang="ts">
import { APP_NAME } from "@icooro/shared";

definePageMeta({ layout: "admin" });

const sections = [
  { label: "Users", to: "/admin/users" },
  { label: "Projects", to: "/admin/projects" },
  { label: "Providers", to: "/admin/providers" },
  { label: "Models", to: "/admin/models" },
  { label: "Jobs", to: "/admin/jobs" },
  { label: "Usage", to: "/admin/usage" },
  { label: "Quotas", to: "/admin/quotas" },
  { label: "Storage", to: "/admin/storage" },
  { label: "Settings", to: "/admin/settings" },
  { label: "Audit logs", to: "/admin/audit" },
  { label: "Security", to: "/admin/security" },
];
</script>

<template>
  <section>
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <h1>Admin control plane</h1>
    <p class="lede">
      The Admin control plane is a separate, role-gated surface. The C6.1
      foundation establishes these routes; full management UIs will be
      delivered in later phases.
    </p>
    <ul class="grid">
      <li v-for="section in sections" :key="section.to">
        <NuxtLink :to="section.to">{{ section.label }}</NuxtLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.eyebrow {
  color: #d35b3e;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 0.5rem;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.6rem;
}
.lede {
  color: #cfd6db;
  max-width: 60ch;
  margin: 0 0 1.5rem;
}
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}
.grid a {
  display: block;
  background: #1a2128;
  border: 1px solid #2a323b;
  border-radius: 6px;
  padding: 0.85rem 1rem;
  text-decoration: none;
  color: #e6e9ec;
  font-weight: 600;
}
.grid a:hover {
  background: #1f272f;
  border-color: #d35b3e;
}
@media (max-width: 680px) {
  .grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
