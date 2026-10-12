/**
 * useTheme — light/dark theme preference for the public site.
 *
 * - `system` (default) follows `prefers-color-scheme`.
 * - `light` / `dark` are explicit user choices.
 * - The resolved value is written to `document.documentElement[data-theme]`,
 *   which the global tokens (`assets/css/tokens.css`) key off.
 * - The chosen mode is persisted in localStorage so the preference survives
 *   reloads. A pre-paint bootstrap script (see nuxt.config.ts) applies the
 *   stored value before hydration, so there is no light flash.
 *
 * Scoped to the public site for now: the signed-in app keeps its own styling
 * until the design system is migrated onto these tokens.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from "vue";

export const THEME_STORAGE_KEY = "icooro:theme-mode";

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = "light" | "dark";

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** Resolve `system` against the OS preference. Exported for tests. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

/** True when the OS asks for a dark interface. Safe outside the browser. */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredMode(): ThemeMode {
  if (typeof localStorage === "undefined") return "system";
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : "system";
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
    return "system";
  }
}

function persistMode(mode: ThemeMode): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Persistence is best-effort; the in-memory preference still applies.
  }
}

function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

export interface UseTheme {
  /** User-chosen mode. `system` follows the OS. */
  mode: Ref<ThemeMode>;
  /** Mode with `system` resolved against the OS preference. */
  resolved: ComputedRef<ResolvedTheme>;
  /** Set the mode explicitly (persists it). */
  setMode: (mode: ThemeMode) => void;
  /** Toggle between light and dark, pinning the choice. */
  toggle: () => void;
}

export function useTheme(): UseTheme {
  const mode = useState<ThemeMode>("theme-mode", () => "system");
  const prefersDark = ref(false);

  const resolved = computed<ResolvedTheme>(() => resolveTheme(mode.value, prefersDark.value));

  function setMode(next: ThemeMode): void {
    mode.value = next;
    persistMode(next);
  }

  function toggle(): void {
    setMode(resolved.value === "dark" ? "light" : "dark");
  }

  // Follow the OS preference while in `system` mode.
  let mediaQuery: MediaQueryList | null = null;
  function onSystemChange(event: MediaQueryListEvent): void {
    prefersDark.value = event.matches;
  }

  onMounted(() => {
    // Read the persisted mode and the OS preference BEFORE applying the
    // attribute, so we never overwrite the pre-paint bootstrap value with a
    // guess.
    mode.value = readStoredMode();
    prefersDark.value = systemPrefersDark();
    applyTheme(resolved.value);
    if (typeof window.matchMedia === "function") {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", onSystemChange);
    }
  });

  onBeforeUnmount(() => {
    mediaQuery?.removeEventListener("change", onSystemChange);
  });

  // Keep the document in sync after the first application in `onMounted`.
  watch(resolved, (value) => applyTheme(value));

  return { mode, resolved, setMode, toggle };
}
