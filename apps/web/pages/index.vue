<script setup lang="ts">
/**
 * Public landing page (F1).
 *
 * The page is a thin composition layer: every string, link and accent comes
 * from the typed content payload in `~/landing/content`, and each section is
 * a focused reusable component under `components/landing/`. Swapping the local
 * payload for CMS-backed data later should not require touching this file's
 * template.
 *
 * The page renders without the default public layout because it owns its own
 * header and footer; `/login` and `/signup` keep the existing layout.
 */
import { landingContent } from "~/landing/content";
import LandingHeader from "~/components/landing/LandingHeader.vue";
import LandingHero from "~/components/landing/LandingHero.vue";
import LandingWorkflow from "~/components/landing/LandingWorkflow.vue";
import LandingFeatures from "~/components/landing/LandingFeatures.vue";
import LandingShowcase from "~/components/landing/LandingShowcase.vue";
import LandingCta from "~/components/landing/LandingCta.vue";
import LandingFooter from "~/components/landing/LandingFooter.vue";

definePageMeta({ layout: false });

useSeoMeta({
  title: landingContent.seo.title,
  description: landingContent.seo.description,
  ogTitle: landingContent.seo.title,
  ogDescription: landingContent.seo.description,
  ogType: "website",
});
</script>

<template>
  <div id="top" class="landing-page">
    <a class="skip-link" href="#main-content">Skip to content</a>

    <LandingHeader :brand="landingContent.brand" :content="landingContent.header" />

    <main id="main-content" class="landing-main">
      <LandingHero :content="landingContent.hero" />
      <LandingWorkflow :content="landingContent.workflow" />
      <LandingFeatures :content="landingContent.features" />
      <LandingShowcase :content="landingContent.showcase" />
      <LandingCta :content="landingContent.closingCta" />
    </main>

    <LandingFooter :brand="landingContent.brand" :content="landingContent.footer" />
  </div>
</template>

<style scoped>
.landing-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.landing-main {
  flex: 1;
}

.skip-link {
  position: absolute;
  top: 0.6rem;
  left: 0.75rem;
  z-index: 50;
  padding: 0.6rem 1rem;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  font-weight: 600;
  text-decoration: none;
  transform: translateY(-300%);
}

.skip-link:focus {
  transform: none;
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
</style>
