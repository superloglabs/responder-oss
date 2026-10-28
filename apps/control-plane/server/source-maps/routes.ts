import { saveSourceMap } from "@responder/core/db/source-maps";
import { Hono } from "hono";
import { authenticateManagementRequest, unauthorizedBody } from "../management/execute.js";

const debugIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isSourceMap(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const map = value as { mappings?: unknown; sections?: unknown; version?: unknown };
  return map.version === 3 && (typeof map.mappings === "string" || Array.isArray(map.sections));
}

// Source map uploads from @superlog/sourcemaps, authenticated with a
// workspace API key. A map is stored under the debug ID written into its
// built file; uploading the same ID again replaces it.
export const sourceMapRoutes = new Hono().put("/:debugId", async (context) => {
  const caller = await authenticateManagementRequest(context.req.raw.headers, "api");
  if (!caller) {
    context.header("WWW-Authenticate", 'Bearer realm="superlog"');
    return context.json(unauthorizedBody, 401);
  }
  const debugId = context.req.param("debugId");
  const file = context.req.query("file")?.trim();
  const release = context.req.query("release")?.trim() || null;
  if (!debugIdPattern.test(debugId) || !file || file.length > 1_000 || (release?.length ?? 0) > 200) {
    return context.json({ code: "invalid_request", error: "Send a debug ID, a file, and at most a 200-character release." }, 400);
  }
  const content = await context.req.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
  if (!isSourceMap(parsed)) {
    return context.json({ code: "invalid_request", error: "The body must be a version 3 source map." }, 400);
  }
  await saveSourceMap({ content, debugId: debugId.toLowerCase(), file, organizationId: caller.organizationId, release });
  return context.json({ debugId: debugId.toLowerCase(), file, release }, 201);
});
