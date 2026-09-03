export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
  typescript: {
    strict: true,
    typeCheck: false,
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
