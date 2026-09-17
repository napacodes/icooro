import { computed, ref, type Ref } from "vue";
import type { Project } from "@icooro/shared";

export interface WorkspaceProjectState {
  project: Ref<Project | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  saving: Ref<boolean>;
  projectId: Ref<string>;
  loadProject: () => Promise<void>;
  updateProject: (updates: { name: string; description?: string | null; status?: string }) => Promise<Project | null>;
  deleteProject: () => Promise<boolean>;
}

export function useWorkspaceProject(): WorkspaceProjectState {
  const route = useRoute();
  const router = useRouter();
  const api = useApi();

  const projectId = computed(() => (route.params.id as string) || "");
  const project = useState<Project | null>(`ws-proj-${projectId.value}`, () => null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const saving = ref(false);

  async function loadProject() {
    if (!projectId.value) return;
    loading.value = true;
    error.value = null;
    try {
      project.value = await api.get<Project>(`/projects/${projectId.value}`);
    } catch (err: any) {
      error.value = err?.message || "Failed to load project workspace";
    } finally {
      loading.value = false;
    }
  }

  async function updateProject(updates: { name: string; description?: string | null; status?: string }) {
    if (!projectId.value) return null;
    saving.value = true;
    try {
      const updated = await api.patch<Project>(`/projects/${projectId.value}`, updates);
      project.value = updated;
      return updated;
    } catch (err: any) {
      throw err;
    } finally {
      saving.value = false;
    }
  }

  async function deleteProject() {
    if (!projectId.value) return false;
    saving.value = true;
    try {
      await api.delete(`/projects/${projectId.value}`);
      project.value = null;
      await router.push("/app/projects");
      return true;
    } catch (err: any) {
      throw err;
    } finally {
      saving.value = false;
    }
  }

  return {
    project,
    loading,
    error,
    saving,
    projectId,
    loadProject,
    updateProject,
    deleteProject,
  };
}
