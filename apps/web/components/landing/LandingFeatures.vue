<script setup lang="ts">
/**
 * Feature cards: the four capabilities the product actually ships with today.
 */
import type { LandingFeaturesContent } from "~/landing/types";
import LandingIcon from "./LandingIcon.vue";

defineProps<{ content: LandingFeaturesContent }>();
</script>

<template>
  <section id="features" class="features" aria-labelledby="features-title">
    <div class="inner">
      <header class="section-head">
        <p class="eyebrow">{{ content.eyebrow }}</p>
        <h2 id="features-title">{{ content.title }}</h2>
        <p class="lede">{{ content.description }}</p>
      </header>

      <ul class="cards">
        <li v-for="item in content.items" :key="item.id" class="card">
          <span class="card-icon"><LandingIcon :name="item.icon" /></span>
          <h3>{{ item.title }}</h3>
          <p>{{ item.description }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.features {
  padding: clamp(2.5rem, 6vw, 4.5rem) 0;
}

.inner {
  max-width: var(--container);
  margin: 0 auto;
  padding: 0 clamp(1.1rem, 4vw, 2rem);
}

.section-head {
  max-width: 44rem;
  margin-bottom: clamp(2rem, 4vw, 3rem);
}

.eyebrow {
  margin: 0 0 0.75rem;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-accent);
}

h2 {
  margin: 0;
  font-size: clamp(1.6rem, 3vw, 2.2rem);
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.lede {
  margin: 0.9rem 0 0;
  color: var(--color-text-muted);
  line-height: 1.65;
}

.cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(1rem, 2.5vw, 1.5rem);
}

.card {
  padding: 1.6rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6rem;
  height: 2.6rem;
  margin-bottom: 1rem;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

h3 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  color: var(--color-text);
}

.card p {
  margin: 0;
  line-height: 1.65;
  color: var(--color-text-muted);
  font-size: 0.95rem;
}

@media (max-width: 760px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
