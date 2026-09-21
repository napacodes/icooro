export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
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
