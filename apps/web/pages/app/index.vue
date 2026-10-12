<script setup lang="ts">
/**
 * User dashboard (F2).
 *
 * A thin composition layer over the existing auth session and the
 * `GET /projects` API contract. All presentation lives in the reusable
 * `components/dashboard/*` components, which are styled with the F1 semantic
 * tokens. No statistics are derived beyond the real project count.
 */
import type { Project, PublicUser } from "@icooro/shared";
import DashboardHeader from "~/components/dashboard/DashboardHeader.vue";
import DashboardSummary from "~/components/dashboard/DashboardSummary.vue";
import ProjectCard from "~/components/dashboard/ProjectCard.vue";

definePageMeta({ layout: "app" });
defineOptions({ name: "UserDashboardPage" });

const auth = useAuth();
const api = useApi();
const user = computed<PublicUser | null>(() => auth.user.value);

const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref("");

/** Most recently created projects first — the API already sorts by createdAt. */
const recentProjects = computed(() => projects.value.slice(0, 6));

async function loadDashboard() {
  loading.value = true;
  error.value = "";
  try {
    projects.value = await api.get<Project[]>("/projects");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Unable to load dashboard data.";
  } finally {
    loading.value = false;
  }
}

onMounted(loadDashboard);
</script>

<template>
  <section class="dashboard-page">
    <DashboardHeader :user-name="user?.name ?? null" />

    <div v-if="loading" class="state-block">
      <LoadingState label="Loading your dashboard…" />
    </div>

    <div v-else-if="error" class="state-block">
      <ErrorBanner :message="error" />
      <BaseButton variant="secondary" size="sm" class="retry-btn" @click="loadDashboard">
        Retry
      </BaseButton>
    </div>

    <EmptyState
      v-else-if="projects.length === 0"
      title="No projects yet"
      description="You haven't created any storytelling projects yet. Start by setting up your first production workspace to plan episodes, scenes, and media assets."
    >
      <NuxtLink to="/app/projects/new" class="btn-primary">Create your first project</NuxtLink>
    </EmptyState>

    <template v-else>
      <DashboardSummary :project-count="projects.length" />

      <section class="recent" aria-labelledby="recent-projects-heading">
        <div class="section-head">
          <h2 id="recent-projects-heading">Recent Projects</h2>
          <NuxtLink to="/app/projects" class="section-link">
            View all ({{ projects.length }})
          </NuxtLink>
        </div>

        <ul class="projects-grid" aria-label="Recent projects">
          <li v-for="project in recentProjects" :key="project.id" class="grid-item">
            <ProjectCard :project="project" />
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.dashboard-page {
  max-width: var(--container);
  margin: 0 auto;
  padding-bottom: 1rem;
}

.state-block {
  margin: 2rem 0;
}

.retry-btn {
  margin-top: 0.75rem;
}

.btn-primary {
  display: inline-block;
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  padding: 0.6rem 1rem;
  border-radius: var(--radius-md);
  text-decoration: none;
  font-weight: 700;
  font-size: 0.9rem;
  transition: background-color var(--motion-fast) ease;
}

.btn-primary:hover {
  background: var(--color-accent-strong);
}

.btn-primary:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.recent {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.section-head h2 {
  margin: 0;
  font-size: 1.25rem;
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.section-link {
  color: var(--color-accent);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9rem;
}

.section-link:hover {
  text-decoration: underline;
}

.section-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}

.projects-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
}

.grid-item {
  display: flex;
}

.grid-item > * {
  flex: 1;
}

@media (min-width: 680px) {
  .projects-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 1080px) {
  .projects-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .btn-primary {
    transition: none;
  }
}
</style>
