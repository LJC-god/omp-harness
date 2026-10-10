import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    include: ["@business-c/contracts"],
  },
});
