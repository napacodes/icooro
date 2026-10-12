<script setup lang="ts">
/**
 * Workflow: the six reviewable stages every production follows.
 * Rendered as an ordered list because the order is the point.
 */
import type { LandingWorkflowContent } from "~/landing/types";
import LandingIcon from "./LandingIcon.vue";

defineProps<{ content: LandingWorkflowContent }>();
</script>

<template>
  <section id="workflow" class="workflow" aria-labelledby="workflow-title">
    <div class="inner">
      <header class="section-head">
        <p class="eyebrow">{{ content.eyebrow }}</p>
        <h2 id="workflow-title">{{ content.title }}</h2>
        <p class="lede">{{ content.description }}</p>
      </header>

      <ol class="steps">
        <li v-for="(step, index) in content.steps" :key="step.id" class="step">
          <div class="step-top">
            <span class="step-icon"><LandingIcon :name="step.icon" /></span>
            <span class="step-index">{{ index + 1 }}</span>
          </div>
          <h3>{{ step.label }}</h3>
          <p>{{ step.description }}</p>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.workflow {
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

.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(1rem, 2.5vw, 1.75rem);
  counter-reset: step;
}

.step {
  padding: 1.4rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.step-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.9rem;
}

.step-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.step-index {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--color-text-faint);
  letter-spacing: 0.06em;
}

h3 {
  margin: 0 0 0.4rem;
  font-size: 1.05rem;
  color: var(--color-text);
}

.step p {
  margin: 0;
  font-size: 0.93rem;
  line-height: 1.6;
  color: var(--color-text-muted);
}

@media (max-width: 900px) {
  .steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .steps {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
