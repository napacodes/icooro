<script setup lang="ts">
/**
 * Showcase: four illustrative "moments" from a production, each drawn with
 * local CSS artwork (no external images, no paid generation). The note makes
 * clear the visuals are representative rather than live project data.
 */
import type { LandingShowcaseContent } from "~/landing/types";

defineProps<{ content: LandingShowcaseContent }>();
</script>

<template>
  <section id="showcase" class="showcase" aria-labelledby="showcase-title">
    <div class="inner">
      <header class="section-head">
        <p class="eyebrow">{{ content.eyebrow }}</p>
        <h2 id="showcase-title">{{ content.title }}</h2>
        <p class="lede">{{ content.description }}</p>
      </header>

      <ul class="items">
        <li v-for="item in content.items" :key="item.id" class="item">
          <div
            class="art"
            :style="{ background: `linear-gradient(135deg, ${item.accentSoft}, ${item.accent})` }"
            aria-hidden="true"
          >
            <span class="line line-strong" />
            <span class="line" />
            <span class="line line-short" />
          </div>
          <h3>{{ item.title }}</h3>
          <p>{{ item.caption }}</p>
        </li>
      </ul>

      <p class="note">{{ content.note }}</p>
    </div>
  </section>
</template>

<style scoped>
.showcase {
  padding: clamp(2.5rem, 6vw, 4.5rem) 0;
  background: var(--color-surface);
  border-block: 1px solid var(--color-border);
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

.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: clamp(1rem, 2.5vw, 1.5rem);
}

.art {
  display: grid;
  align-content: end;
  gap: 0.5rem;
  aspect-ratio: 4 / 3;
  padding: 1.1rem;
  border-radius: var(--radius-md);
  margin-bottom: 0.9rem;
  box-shadow: var(--shadow-sm);
}

.line {
  display: block;
  height: 0.5rem;
  width: 70%;
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.55);
}

.line-strong {
  width: 45%;
  height: 0.7rem;
  background: rgba(255, 255, 255, 0.85);
}

.line-short {
  width: 30%;
}

h3 {
  margin: 0 0 0.35rem;
  font-size: 1.02rem;
  color: var(--color-text);
}

.item p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.note {
  margin: 1.5rem 0 0;
  font-size: 0.82rem;
  color: var(--color-text-faint);
}

@media (max-width: 900px) {
  .items {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .items {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
