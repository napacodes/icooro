/**
 * useAuth — manages the current user session on the client.
 *
 * Backed by `/api/v1/auth/*`. The session cookie is HTTP-only, so this
 * composable never sees the token — it only sees the public user object.
 */
import type { PublicUser, LoginInput, SignupInput, UserRole } from "@icooro/shared";

interface AuthState {
  user: PublicUser | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

export function useAuth() {
  const state = useState<AuthState>("auth", () => ({
    user: null,
    status: "idle",
    error: null,
  }));
  const api = useApi();

  async function refresh(): Promise<PublicUser | null> {
    state.value.status = "loading";
    state.value.error = null;
    try {
      const user = await api.get<PublicUser>("/auth/me");
      state.value.user = user;
      state.value.status = "ready";
      return user;
    } catch (err: unknown) {
      state.value.user = null;
      state.value.status = "ready";
      // 401 is the expected "not signed in" case; do not surface as error.
      if (err && typeof err === "object" && "status" in err) {
        const status = (err as { status?: number }).status;
        if (status === 401) return null;
      }
      state.value.error = err instanceof Error ? err.message : "Failed to load session";
      return null;
    }
  }

  async function signup(input: SignupInput): Promise<PublicUser> {
    state.value.status = "loading";
    state.value.error = null;
    try {
      const user = await api.post<PublicUser>("/auth/signup", input);
      state.value.user = user;
      state.value.status = "ready";
      return user;
    } catch (err: unknown) {
      state.value.status = "error";
      state.value.error = err instanceof Error ? err.message : "Signup failed";
      throw err;
    }
  }

  async function login(input: LoginInput): Promise<PublicUser> {
    state.value.status = "loading";
    state.value.error = null;
    try {
      const user = await api.post<PublicUser>("/auth/login", input);
      state.value.user = user;
      state.value.status = "ready";
      return user;
    } catch (err: unknown) {
      state.value.status = "error";
      state.value.error = err instanceof Error ? err.message : "Login failed";
      throw err;
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.post<{ ok: boolean }>("/auth/logout", {});
    } catch {
      // Logout is best-effort; clear local state regardless.
    }
    state.value.user = null;
    state.value.status = "ready";
  }

  const isAuthenticated = computed(() => state.value.user !== null);
  const role = computed<UserRole | null>(() => state.value.user?.role ?? null);
  const isAdmin = computed(() => role.value === "admin");

  return {
    state: readonly(state),
    user: computed(() => state.value.user),
    isAuthenticated,
    role,
    isAdmin,
    refresh,
    signup,
    login,
    logout,
  };
}
