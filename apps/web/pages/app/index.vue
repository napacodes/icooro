<script setup lang="ts">
import type { PublicUser } from "@icooro/shared";

definePageMeta({ layout: "app" });

const auth = useAuth();
const user = computed<PublicUser | null>(() => auth.user.value);
</script>

<template>
  <section>
    <h1>Dashboard</h1>
    <p v-if="user" class="muted">
      Welcome back, <strong>{{ user.name }}</strong>. Pick a project from the sidebar to continue working.
    </p>
    <p v-else class="muted">Loading your workspace…</p>
    <div class="grid">
      <article class="card">
        <h2>Projects</h2>
        <p>Plan new projects or continue an existing one.</p>
        <NuxtLink to="/app/projects" class="button">Open projects</NuxtLink>
      </article>
      <article class="card">
        <h2>Create</h2>
        <p>Start a fresh project workspace.</p>
        <NuxtLink to="/app/projects/new" class="button">New project</NuxtLink>
      </article>
    </div>
  </section>
</template>

<style scoped>
h1 {
  margin: 0 0 0.25rem;
}
.muted {
  color: #52606d;
  margin: 0 0 1.5rem;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  max-width: 760px;
}
.card {
  background: #fff;
  border: 1px solid #d4dfdd;
  border-radius: 8px;
  padding: 1.25rem;
}
.card h2 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
}
.card p {
  color: #52606d;
  margin: 0 0 1rem;
}
.button {
  display: inline-block;
  background: #176b65;
  color: #fff;
  padding: 0.55rem 0.85rem;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 700;
}
@media (max-width: 680px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
