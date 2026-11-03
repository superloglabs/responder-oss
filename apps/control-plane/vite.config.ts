import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { superlogSourceMaps } from "@superlog/sourcemaps/vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { publicDocumentPathnames } from "./src/public-routes.js";

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
// With a Superlog API key, the build tags its scripts with debug IDs and
// uploads their maps, so browser errors in Superlog show the original source.
// SUPERLOG_URL is the instance to upload to and defaults to superlog.sh.
const uploadsSuperlogSourceMaps = Boolean(process.env.SUPERLOG_API_KEY?.trim());
const publicDocumentPaths: ReadonlySet<string> = new Set(publicDocumentPathnames);

// Tags and uploads before any other plugin writes, so Sentry's upload, when
// configured, finds the maps and deletes them afterwards.
function superlogSourceMapUpload(): Plugin {
  const plugin = superlogSourceMaps({
    deleteAfterUpload: !uploadsSentrySourceMaps,
    release,
    url: process.env.SUPERLOG_URL?.trim() || undefined,
  }) as Plugin;
  const writeBundle = plugin.writeBundle as Extract<Plugin["writeBundle"], (...args: never[]) => unknown>;
  return { ...plugin, writeBundle: { handler: writeBundle, order: "pre", sequential: true } };
}

const previewDocumentRoutes: Plugin = {
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url) return next();

      const url = new URL(request.url, "http://preview.local");
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const publicDocumentPath =
        url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
      if (publicDocumentPath !== "/" && publicDocumentPaths.has(publicDocumentPath)) {
        request.url = `${publicDocumentPath}/index.html${url.search}`;
      } else if (
        url.pathname !== "/" &&
        url.pathname !== "/api" &&
        !url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/.well-known/") &&
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
    sourcemap: buildsSentrySourceMaps || uploadsSuperlogSourceMaps ? "hidden" : false,
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
    ...(uploadsSuperlogSourceMaps ? [superlogSourceMapUpload()] : []),
  ],
  preview: {
    proxy: {
      "/.well-known": `http://127.0.0.1:${apiPort}`,
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
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
      "/.well-known": `http://127.0.0.1:${apiPort}`,
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
