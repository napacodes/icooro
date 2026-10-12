<script setup lang="ts">
/**
 * Hero: headline, supporting copy, the two account CTAs, and the product
 * preview. All copy comes from the content payload.
 */
import type { LandingHeroContent } from "~/landing/types";
import ProductPreview from "./ProductPreview.vue";

defineProps<{ content: LandingHeroContent }>();
</script>

<template>
  <section class="hero" aria-labelledby="hero-title">
    <div class="grid">
      <div class="copy">
        <p class="eyebrow">{{ content.eyebrow }}</p>
        <h1 id="hero-title">{{ content.headline }}</h1>
        <p class="supporting">{{ content.supporting }}</p>
        <div class="actions">
          <NuxtLink :to="content.primaryCta.to" class="btn btn-primary">
            {{ content.primaryCta.label }}
          </NuxtLink>
          <NuxtLink :to="content.secondaryCta.to" class="btn btn-secondary">
            {{ content.secondaryCta.label }}
          </NuxtLink>
        </div>
      </div>

      <div class="media">
        <ProductPreview :content="content.preview" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  padding: clamp(3rem, 8vw, 5.5rem) 0 clamp(2.5rem, 6vw, 4.5rem);
}

.grid {
  max-width: var(--container);
  margin: 0 auto;
  padding: 0 clamp(1.1rem, 4vw, 2rem);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.02fr);
  gap: clamp(2rem, 5vw, 3.5rem);
  align-items: center;
}

.eyebrow {
  margin: 0 0 1rem;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-accent);
}

h1 {
  margin: 0;
  font-size: clamp(2.1rem, 4.6vw, 3.3rem);
  line-height: 1.08;
  letter-spacing: -0.02em;
  color: var(--color-text);
  overflow-wrap: break-word;
}

.supporting {
  margin: 1.25rem 0 2rem;
  font-size: clamp(1rem, 1.4vw, 1.1rem);
  line-height: 1.65;
  color: var(--color-text-muted);
  max-width: 34rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.8rem 1.4rem;
  border-radius: var(--radius-md);
  font-weight: 700;
  font-size: 0.98rem;
  text-decoration: none;
  border: 1px solid transparent;
  transition:
    background-color var(--motion-fast) ease,
    border-color var(--motion-fast) ease,
    color var(--motion-fast) ease;
}

.btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.btn-primary {
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  box-shadow: var(--shadow-sm);
}

.btn-primary:hover {
  background: var(--color-accent-strong);
}

.btn-secondary {
  color: var(--color-text);
  background: var(--color-surface);
  border-color: var(--color-border-strong);
}

.btn-secondary:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

@media (max-width: 980px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
