<script setup lang="ts">
import { APP_NAME } from "@icooro/shared";

definePageMeta({ layout: "default" });
</script>

<template>
  <main class="page">
    <section class="hero">
      <p class="eyebrow">{{ APP_NAME }}</p>
      <h1>AI-native video production, end to end.</h1>
      <p class="lede">
        Plan stories, build episodes, and generate media with a single workspace.
      </p>
      <div class="actions">
        <NuxtLink to="/app" class="cta">Open the app</NuxtLink>
        <NuxtLink to="/signup" class="secondary">Create an account</NuxtLink>
      </div>
    </section>
    <section class="features">
      <article>
        <h2>Story</h2>
        <p>Episodes, scripts, scenes, and shots — planned together.</p>
      </article>
      <article>
        <h2>Media</h2>
        <p>Generate, version, and approve assets in one place.</p>
      </article>
      <article>
        <h2>Generations</h2>
        <p>Submit, poll, and persist provider results with a single click.</p>
      </article>
    </section>
  </main>
</template>

<style scoped>
.page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 4rem 1.5rem 6rem;
  color: #17212b;
  font-family: system-ui, sans-serif;
}
.hero {
  text-align: center;
  margin-bottom: 4rem;
}
.eyebrow {
  color: #4c6fff;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 1rem;
}
h1 {
  font-size: clamp(2.25rem, 5vw, 3.5rem);
  margin: 0 0 1rem;
}
.lede {
  color: #52606d;
  font-size: 1.1rem;
  margin: 0 0 2rem;
}
.actions {
  display: inline-flex;
  gap: 0.75rem;
}
.cta {
  display: inline-block;
  background: #304fd8;
  color: #fff;
  padding: 0.75rem 1.1rem;
  border-radius: 6px;
  text-decoration: none;
  font-weight: 700;
}
.secondary {
  display: inline-block;
  background: #eef1ff;
  color: #243da8;
  padding: 0.75rem 1.1rem;
  border-radius: 6px;
  text-decoration: none;
  font-weight: 700;
}
.features {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.25rem;
}
.features article {
  background: #fff;
  border: 1px solid #dbe2ea;
  border-radius: 8px;
  padding: 1.5rem;
}
.features h2 {
  margin: 0 0 0.5rem;
  font-size: 1.15rem;
}
.features p {
  color: #52606d;
  margin: 0;
}
@media (max-width: 760px) {
  .features {
    grid-template-columns: 1fr;
  }
}
</style>
