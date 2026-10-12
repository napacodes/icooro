/**
 * Pre-paint theme bootstrap. The stored preference (`system` | `light` |
 * `dark`, see `composables/useTheme.ts`) is applied to `<html data-theme>`
 * before the first paint so dark-mode visitors never see a light flash.
 * Kept dependency-free and defensive: any failure falls back to light.
 */
const THEME_BOOTSTRAP = `(function(){try{
  var k="icooro:theme-mode";
  var stored=localStorage.getItem(k);
  var mode=(stored==="light"||stored==="dark"||stored==="system")?stored:"system";
  var prefersDark=window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme=mode==="system"?(prefersDark?"dark":"light"):mode;
  document.documentElement.setAttribute("data-theme",theme);
}catch(e){}})();`;

export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
  // Global design tokens (light default, dark under `[data-theme="dark"]`).
  css: ["~/assets/css/tokens.css"],
  app: {
    head: {
      htmlAttrs: { lang: "en" },
      script: [{ innerHTML: THEME_BOOTSTRAP }],
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
  // Register `~/components` by filename (StatusPill, EmptyState, …) rather
  // than the path-prefixed `Base*` names. The shared components stay in
  // `components/base/`; this just makes the names already used across the
  // app and tests resolve instead of emitting "Failed to resolve component".
  components: {
    dirs: [{ path: "~/components", pathPrefix: false }],
  },
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? "http://localhost:3001",
    },
  },
  devServer: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT ?? 3000),
  },
});
