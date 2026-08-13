import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const webPort = Number(
  process.env.PORT ?? process.env.CONTROL_PLANE_WEB_PORT ?? 3000,
);
const apiPort = Number(process.env.CONTROL_PLANE_API_PORT ?? 8787);
const release =
  process.env.SENTRY_RELEASE?.trim() ||
  process.env.VITE_SENTRY_RELEASE?.trim() ||
  undefined;
const uploadsSentrySourceMaps = Boolean(
  process.env.SENTRY_AUTH_TOKEN?.trim() &&
    process.env.SENTRY_ORG?.trim() &&
    process.env.SENTRY_PROJECT?.trim(),
);
const buildsSentrySourceMaps =
  uploadsSentrySourceMaps || process.env.SENTRY_BUILD_SOURCEMAPS === "true";

export default defineConfig({
  build: {
    sourcemap: buildsSentrySourceMaps ? "hidden" : false,
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(uploadsSentrySourceMaps
      ? [
          sentryVitePlugin({
            authToken: process.env.SENTRY_AUTH_TOKEN,
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            release: release ? { name: release } : undefined,
            sourcemaps: {
              filesToDeleteAfterUpload: "./dist/**/*.map",
            },
            telemetry: false,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    allowedHosts: [".local", ".localhost", ".trycloudflare.com"],
    host: process.env.HOST ?? "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
