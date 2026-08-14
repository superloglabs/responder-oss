import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app.js";
import { isSourceMapPath } from "./static-assets.js";

const staticRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const serveAsset = serveStatic({ root: staticRoot });
const serveAppShell = serveStatic({ path: "app.html", root: staticRoot });

export const productionApp = new Hono()
  .route("/", app)
  .use("*", async (context, next) => {
    if (isSourceMapPath(context.req.path)) return context.notFound();
    return next();
  })
  .use("*", serveAsset)
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
