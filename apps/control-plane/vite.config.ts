import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

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

const previewDocumentRoutes: Plugin = {
  configurePreviewServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (!request.url) return next();

      const url = new URL(request.url, "http://preview.local");
      if (url.pathname === "/blog" || url.pathname === "/blog/") {
        request.url = `/blog/index.html${url.search}`;
      } else if (
        url.pathname !== "/" &&
        !url.pathname.split("/").pop()?.includes(".")
      ) {
        request.url = `/app.html${url.search}`;
      }
      next();
    });
  },
  name: "preview-document-routes",
};

export default defineConfig({
  build: {
    sourcemap: buildsSentrySourceMaps ? "hidden" : false,
  },
  plugins: [
    previewDocumentRoutes,
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
