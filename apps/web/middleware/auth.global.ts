/**
 * Global auth middleware.
 *
 * - `/app/**` and `/admin/**` require an authenticated user.
 * - Public routes (`/`, `/login`, `/signup`) are accessible without a session.
 * - If the user is unauthenticated, redirect to `/login?redirect=<from>`.
 * - If the user is authenticated and visits `/login` or `/signup`, redirect
 *   to `/app`.
 */
import type { PublicUser } from "@icooro/shared";

const PUBLIC_PREFIXES = new Set(["/login", "/signup"]);
const APP_PREFIX = "/app";
const ADMIN_PREFIX = "/admin";

export default defineNuxtRouteMiddleware(async (to) => {
  const path = to.path;
  const isPublic = path === "/" || PUBLIC_PREFIXES.has(path);
  const requiresAuth = path === APP_PREFIX || path.startsWith(`${APP_PREFIX}/`) ||
    path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);

  if (!requiresAuth && !isPublic) {
    return; // unknown path; let the route decide (e.g. 404)
  }

  // Server-side rendering: do not gate; the client will re-evaluate.
  if (import.meta.server) return;

  const auth = useAuth();
  // If we have never loaded the session, load it now.
  if (auth.state.value.status === "idle") {
    await auth.refresh();
  }

  if (requiresAuth) {
    if (!auth.isAuthenticated.value) {
      const redirect = encodeURIComponent(to.fullPath);
      return navigateTo(`/login?redirect=${redirect}`);
    }
    if (path.startsWith(ADMIN_PREFIX) && !auth.isAdmin.value) {
      return navigateTo("/app");
    }
    return;
  }

  // Public auth pages: redirect to /app if already signed in.
  if (PUBLIC_PREFIXES.has(path) && auth.isAuthenticated.value) {
    return navigateTo("/app");
  }
});

// Helper used by the smoke test to peek the user type without importing it.
export type { PublicUser };
