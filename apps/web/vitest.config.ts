import { defineConfig } from "vitest/config";
// @ts-expect-error - @vitejs/plugin-vue and Vitest's bundled vite version are
// out of sync in the workspace; runtime works fine, the types disagree.
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // @ts-expect-error - same as above; vite 5 / 7 cross-version plugin types.
  plugins: [vue()],
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
  resolve: {
    alias: {
      "~": new URL("./", import.meta.url).pathname,
      "@": new URL("./", import.meta.url).pathname,
    },
  },
});
