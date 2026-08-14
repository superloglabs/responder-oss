import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: ".prerender",
    rollupOptions: {
      input: "src/prerender-entry.tsx",
      output: {
        entryFileNames: "[name].js",
      },
    },
    ssr: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
