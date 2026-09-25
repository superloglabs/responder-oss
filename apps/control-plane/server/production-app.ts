import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { sharedAutomationTemplateSlugSchema } from "../../../packages/core/src/automations/shared-template.js";
import { getSharedAutomationTemplate } from "../../../packages/core/src/db/shared-automation-templates.js";
import { app } from "./app.js";
import { sharedTemplateDocument } from "./automations/shared-templates.js";
import { controlPlaneBaseUrl } from "./integrations/urls.js";
import { isSourceMapPath } from "./static-assets.js";

const staticRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const serveAsset = serveStatic({ root: staticRoot });
const serveAppShell = serveStatic({ path: "app.html", root: staticRoot });
let appShell: Promise<string> | undefined;

export const productionApp = new Hono()
  .route("/", app)
  .use("*", async (context, next) => {
    if (isSourceMapPath(context.req.path)) return context.notFound();
    return next();
  })
  .use("*", serveAsset)
  .get("/templates/:slug", async (context, next) => {
    // Unknown or stopped templates fall through to the application, which
    // shows its own not-found state.
    const slug = sharedAutomationTemplateSlugSchema.safeParse(
      context.req.param("slug"),
    );
    if (!slug.success) return next();
    const template = await getSharedAutomationTemplate(slug.data).catch(
      () => null,
    );
    if (!template) return next();
    appShell ??= readFile(path.join(staticRoot, "app.html"), "utf8");
    const shell = await appShell.catch(() => {
      appShell = undefined;
      return null;
    });
    if (!shell) return next();
    return context.html(
      sharedTemplateDocument(shell, template, controlPlaneBaseUrl()),
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
