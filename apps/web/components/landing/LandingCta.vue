<script setup lang="ts">
/**
 * Closing call to action. Uses the same two account destinations as the hero —
 * there is no pricing or contact page to point at yet.
 */
import type { LandingClosingCtaContent } from "~/landing/types";

defineProps<{ content: LandingClosingCtaContent }>();
</script>

<template>
  <section class="cta" aria-labelledby="cta-title">
    <div class="inner">
      <h2 id="cta-title">{{ content.title }}</h2>
      <p class="lede">{{ content.description }}</p>
      <div class="actions">
        <NuxtLink :to="content.primaryCta.to" class="btn btn-primary">
          {{ content.primaryCta.label }}
        </NuxtLink>
        <NuxtLink :to="content.secondaryCta.to" class="btn btn-secondary">
          {{ content.secondaryCta.label }}
        </NuxtLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cta {
  padding: clamp(2.75rem, 7vw, 5rem) 0;
}

.inner {
  max-width: var(--container);
  margin: 0 auto;
  padding: 0 clamp(1.1rem, 4vw, 2rem);
  text-align: center;
}

h2 {
  margin: 0;
  font-size: clamp(1.6rem, 3.2vw, 2.3rem);
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.lede {
  margin: 0.9rem auto 1.75rem;
  max-width: 40rem;
  color: var(--color-text-muted);
  line-height: 1.65;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.8rem 1.5rem;
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
</style>
