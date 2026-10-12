<script setup lang="ts">
/**
 * Public site header: wordmark, in-page navigation, theme switch, and the
 * only two account CTAs that exist today (sign in / create account).
 */
import type { LandingBrand, LandingHeaderContent } from "~/landing/types";
import ThemeToggle from "./ThemeToggle.vue";

defineProps<{
  brand: LandingBrand;
  content: LandingHeaderContent;
}>();
</script>

<template>
  <header class="site-header">
    <div class="bar">
      <a class="brand" href="#top">
        <svg class="mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
          <rect x="2" y="2" width="24" height="24" rx="7" fill="currentColor" />
          <path d="M11.4 9.4l7.2 4.6-7.2 4.6z" fill="var(--color-accent-contrast)" />
        </svg>
        <span class="wordmark">{{ brand.name }}</span>
      </a>

      <nav class="nav" aria-label="Primary">
        <a v-for="item in content.nav" :key="item.href" class="nav-link" :href="item.href">
          {{ item.label }}
        </a>
      </nav>

      <div class="actions">
        <ThemeToggle :label="content.themeToggleLabel" />
        <NuxtLink :to="content.signIn.to" class="btn btn-ghost">{{ content.signIn.label }}</NuxtLink>
        <NuxtLink :to="content.signUp.to" class="btn btn-primary">{{ content.signUp.label }}</NuxtLink>
      </div>
    </div>
  </header>
</template>

<style scoped>
.site-header {
  position: sticky;
  top: 0;
  z-index: 20;
  background: color-mix(in srgb, var(--color-surface) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--color-border);
}

.bar {
  max-width: var(--container);
  margin: 0 auto;
  padding: 0.85rem clamp(1.1rem, 4vw, 2rem);
  display: flex;
  align-items: center;
  gap: 1rem;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  text-decoration: none;
  color: var(--color-accent);
  font-weight: 700;
}

.brand:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}

.mark {
  width: 1.75rem;
  height: 1.75rem;
}

.wordmark {
  color: var(--color-text);
  font-size: 1.05rem;
  letter-spacing: 0.02em;
}

.nav {
  display: flex;
  gap: 1.5rem;
  margin-left: 1.5rem;
}

.nav-link {
  color: var(--color-text-muted);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.95rem;
  padding: 0.25rem 0;
  border-bottom: 2px solid transparent;
  transition:
    color var(--motion-fast) ease,
    border-color var(--motion-fast) ease;
}

.nav-link:hover {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

.nav-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 4px;
  border-radius: 2px;
}

.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.95rem;
  border-radius: var(--radius-md);
  font-weight: 600;
  font-size: 0.92rem;
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
}

.btn-primary:hover {
  background: var(--color-accent-strong);
}

.btn-ghost {
  color: var(--color-text);
  border-color: var(--color-border);
  background: var(--color-surface);
}

.btn-ghost:hover {
  border-color: var(--color-border-strong);
  color: var(--color-accent);
}

@media (max-width: 860px) {
  .nav {
    display: none;
  }
}

@media (max-width: 560px) {
  .actions .btn-ghost {
    display: none;
  }
}
</style>
