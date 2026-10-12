<script setup lang="ts">
/**
 * Public footer. Link columns mix in-page anchors and real routes; a CMS can
 * add, remove or reorder them without touching this template. The copyright
 * year is derived at render time rather than stored as content.
 */
import { computed } from "vue";
import type { LandingBrand, LandingFooterContent, LandingLink, LandingAnchor } from "~/landing/types";

const props = defineProps<{
  brand: LandingBrand;
  content: LandingFooterContent;
}>();

const year = computed(() => new Date().getFullYear());

function isRoute(link: LandingLink | LandingAnchor): link is LandingLink {
  return "to" in link && typeof link.to === "string";
}
</script>

<template>
  <footer class="site-footer">
    <div class="inner">
      <div class="brand-block">
        <span class="wordmark">{{ brand.name }}</span>
        <p class="tagline">{{ content.tagline }}</p>
      </div>

      <nav
        v-for="column in content.columns"
        :key="column.title"
        class="column"
        :aria-label="column.title"
      >
        <h2 class="column-title">{{ column.title }}</h2>
        <ul>
          <li v-for="link in column.links" :key="link.label">
            <NuxtLink v-if="isRoute(link)" :to="link.to">{{ link.label }}</NuxtLink>
            <a v-else :href="link.href">{{ link.label }}</a>
          </li>
        </ul>
      </nav>
    </div>

    <div class="legal">
      <span>&copy; {{ year }} {{ brand.name }}</span>
    </div>
  </footer>
</template>

<style scoped>
.site-footer {
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
  padding: clamp(2rem, 5vw, 3rem) 0 0;
}

.inner {
  max-width: var(--container);
  margin: 0 auto;
  padding: 0 clamp(1.1rem, 4vw, 2rem);
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) repeat(2, minmax(0, 1fr));
  gap: clamp(1.5rem, 4vw, 3rem);
}

.wordmark {
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--color-text);
}

.tagline {
  margin: 0.5rem 0 0;
  color: var(--color-text-muted);
  font-size: 0.92rem;
  max-width: 22rem;
}

.column-title {
  margin: 0 0 0.75rem;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}

.column ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.column a {
  color: var(--color-text-muted);
  text-decoration: none;
  font-size: 0.93rem;
}

.column a:hover {
  color: var(--color-accent);
}

.column a:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 3px;
  border-radius: 2px;
}

.legal {
  max-width: var(--container);
  margin: clamp(1.75rem, 4vw, 2.5rem) auto 0;
  padding: 1.1rem clamp(1.1rem, 4vw, 2rem);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-faint);
  font-size: 0.84rem;
}

@media (max-width: 700px) {
  .inner {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
