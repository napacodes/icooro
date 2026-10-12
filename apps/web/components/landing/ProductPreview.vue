<script setup lang="ts">
/**
 * Stylised product preview used in the hero.
 *
 * It renders real workspace structure (plan stages, a shot list, job states)
 * with illustrative content — the caption states that explicitly, so the
 * preview is never mistaken for live production data.
 */
import type { LandingProductPreviewContent } from "~/landing/types";

defineProps<{ content: LandingProductPreviewContent }>();
</script>

<template>
  <figure class="preview">
    <div class="window">
      <div class="window-bar">
        <span class="dots" aria-hidden="true"><i /><i /><i /></span>
        <span class="window-title">{{ content.title }}</span>
        <span class="window-badge">Preview</span>
      </div>

      <div class="window-body">
        <aside class="rail">
          <p class="rail-label">{{ content.stagesLabel }}</p>
          <ol class="stages">
            <li
              v-for="stage in content.stages"
              :key="stage.label"
              class="stage"
              :class="`is-${stage.state}`"
            >
              <span class="stage-marker" aria-hidden="true" />
              <span class="stage-label">{{ stage.label }}</span>
              <span class="sr-only">({{ stage.state }})</span>
            </li>
          </ol>
        </aside>

        <div class="panel">
          <p class="panel-title">{{ content.listLabel }}</p>
          <ul class="rows">
            <li v-for="row in content.rows" :key="row.label" class="row">
              <span class="row-label">{{ row.label }}</span>
              <span class="row-status" :class="`is-${row.tone}`">{{ row.status }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
    <figcaption class="note">{{ content.note }}</figcaption>
  </figure>
</template>

<style scoped>
.preview {
  margin: 0;
}

.window {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.window-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 1rem;
  background: var(--color-surface-subtle);
  border-bottom: 1px solid var(--color-border);
}

.dots {
  display: inline-flex;
  gap: 0.3rem;
}

.dots i {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: var(--radius-full);
  background: var(--color-border-strong);
}

.window-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-muted);
}

.window-badge {
  margin-left: auto;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-radius: var(--radius-full);
  padding: 0.2rem 0.6rem;
}

.window-body {
  display: grid;
  grid-template-columns: minmax(9rem, 13rem) minmax(0, 1fr);
}

.rail {
  padding: 1rem;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
}

.rail-label,
.panel-title {
  margin: 0 0 0.75rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}

.stages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.55rem;
  /* Positioned so the sr-only state text inside a horizontally scrollable
     rail is clipped by the rail instead of widening the document. */
  position: relative;
}

.stage {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.9rem;
  color: var(--color-text-muted);
}

.stage.is-active {
  color: var(--color-text);
  font-weight: 700;
}

.stage-marker {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: var(--radius-full);
  background: var(--color-pending);
  flex: none;
}

.stage.is-done .stage-marker {
  background: var(--color-success);
}

.stage.is-active .stage-marker {
  background: var(--color-accent);
  box-shadow: 0 0 0 4px var(--color-accent-soft);
}

.panel {
  padding: 1rem 1.1rem;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
}

.row-label {
  font-size: 0.88rem;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.row-status {
  flex: none;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: var(--radius-full);
}

.row-status.is-success {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.row-status.is-pending {
  color: var(--color-text-muted);
  background: var(--color-pending-soft);
}

.note {
  margin: 0.7rem 0 0;
  font-size: 0.8rem;
  color: var(--color-text-faint);
  text-align: center;
}

@media (max-width: 640px) {
  .window-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .rail {
    border-right: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .stages {
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    overflow-x: auto;
    padding-bottom: 0.25rem;
    /* Decorative preview: keep the rail clean while still scrollable. */
    scrollbar-width: none;
  }

  .stages::-webkit-scrollbar {
    display: none;
  }
}
</style>
