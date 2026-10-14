import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app.js";
import { appShellLoader } from "./app-shell.js";
import { sharedTemplateDocument, templatePreview } from "./automations/shared-templates.js";
import { controlPlaneBaseUrl } from "./integrations/urls.js";
import { isSourceMapPath } from "./static-assets.js";

const staticRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const serveAsset = serveStatic({ root: staticRoot });
const serveAppShell = serveStatic({ path: "app.html", root: staticRoot });
const loadAppShell = appShellLoader({
  baseUrl: controlPlaneBaseUrl,
  readLocal: () => readFile(path.join(staticRoot, "app.html"), "utf8"),
});

export const productionApp = new Hono()
  .route("/", app)
  .use("*", async (context, next) => {
    if (isSourceMapPath(context.req.path)) return context.notFound();
    return next();
  })
  .use("*", serveAsset)
  .get("/templates/*", async (context, next) => {
    // The path names a built-in template id or a shared template slug, with
    // or without a trailing slash. Link previews get the template's title and
    // description. Unknown or stopped templates get the plain shell, and the
    // application shows its own not-found state. Deeper paths are not found.
    const slug = context.req.path.slice("/templates/".length).replace(/\/$/u, "");
    if (!slug || slug.includes("/")) return next();
    const [template, shell] = await Promise.all([
      templatePreview(slug),
      loadAppShell(),
    ]);
    if (!shell) return next();
    return context.html(
      template
        ? sharedTemplateDocument(shell, template, controlPlaneBaseUrl())
        : shell,
    );
  })
  .get("*", async (context, next) => {
    if (
      context.req.path === "/api" ||
      context.req.path.startsWith("/api/") ||
      context.req.path === "/mcp" ||
      context.req.path.startsWith("/mcp/")
    ) {
      return context.notFound();
    }
    return serveAppShell(context, next);
  });
